import { DoorError } from "@npc/door-sdk";
import { describe, expect, it } from "vitest";

import {
  chooseNextDoor,
  ResidencyController,
  type AbortableSleep,
  type DepartRequest,
  type LiveResidency,
  type ResidencyControllerOptions
} from "../src/residency/controller.js";
import type { DepartResult } from "../src/session/session.js";
import { FakeTimer } from "./helpers/fake-timer.js";

const HOUR = 3_600_000;

type Logged = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(): {
  logger: ResidencyControllerOptions["logger"];
  entries: Logged[];
} {
  const entries: Logged[] = [];
  const make =
    (level: string) =>
    (fields: unknown, msg?: string): void => {
      entries.push({ level, msg: msg ?? "", fields: (fields ?? {}) as Record<string, unknown> });
    };
  const logger = {
    info: make("info"),
    warn: make("warn"),
    error: make("error")
  } as unknown as ResidencyControllerOptions["logger"];
  return { logger, entries };
}

function departResult(epoch: number): DepartResult {
  return {
    witnessed: 2,
    declined: 1,
    screened: 0,
    journalPath: `/j/journal-epoch-${String(epoch)}.md`
  };
}

type FakeResidency = LiveResidency & { departRequests: DepartRequest[]; bareCalls: number };

/**
 * World of fake Doors and residencies; `online` is the set `probe` reports, `events`
 * records lifecycle order (`arrive:<door>:<epoch>`, `depart:<epoch>`, …).
 */
function fakeWorld(
  opts: {
    online?: string[];
    depart?: (residency: FakeResidency) => Promise<DepartResult>;
    departBare?: (residency: FakeResidency) => Promise<void>;
    /** Arrival attempts that throw (after the first residency). */
    arriveFailures?: number;
  } = {}
) {
  const events: string[] = [];
  const residencies: FakeResidency[] = [];
  const online = new Set(opts.online ?? ["a", "b", "c"]);
  let nextEpoch = 1;
  let arriveFailures = opts.arriveFailures ?? 0;
  const arriveCalls: string[] = [];
  const probe = async (): Promise<string[]> => [...online].sort();
  const arrive = async (doorId: string): Promise<LiveResidency> => {
    arriveCalls.push(doorId);
    if (residencies.length > 0 && arriveFailures > 0) {
      arriveFailures -= 1;
      events.push(`arrive_failed:${doorId}`);
      throw new Error("door unavailable");
    }
    const epoch = nextEpoch;
    nextEpoch += 1;
    const residency: FakeResidency = {
      doorId,
      epoch,
      departRequests: [],
      bareCalls: 0,
      detach: async () => {
        events.push(`detach:${String(epoch)}`);
      },
      depart: async (request) => {
        residency.departRequests.push(request);
        events.push(`depart:${String(epoch)}`);
        return opts.depart !== undefined ? opts.depart(residency) : departResult(epoch);
      },
      departBare: async () => {
        residency.bareCalls += 1;
        events.push(`depart_bare:${String(epoch)}`);
        await opts.departBare?.(residency);
        return { departure: true };
      },
      close: async () => {
        events.push(`close:${String(epoch)}`);
      }
    };
    residencies.push(residency);
    events.push(`arrive:${doorId}:${String(epoch)}`);
    return residency;
  };
  return { events, residencies, online, probe, arrive, arriveCalls };
}

/** Sleep that records delays and resolves immediately. */
function instantSleep(): { sleep: AbortableSleep; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    }
  };
}

/** Sleep that only resolves when aborted (simulates a long wait). */
const hangingSleep: AbortableSleep = (_ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true }
    );
  });

/** Deterministic RNG: always the first candidate. */
const first = (): number => 0;

function controllerWith(
  world: ReturnType<typeof fakeWorld>,
  overrides: Partial<ResidencyControllerOptions> = {}
) {
  const timer = new FakeTimer();
  let now = 1_000_000;
  const { logger, entries } = recordingLogger();
  const { sleep, delays } = instantSleep();
  const controller = new ResidencyController({
    probe: world.probe,
    arrive: world.arrive,
    random: first,
    maxResidencyMs: 0,
    nowMs: () => now,
    timer,
    sleep,
    logger,
    ...overrides
  });
  return {
    controller,
    timer,
    entries,
    delays,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

async function settle(controller: ResidencyController): Promise<void> {
  while (controller.cycling) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("chooseNextDoor", () => {
  it("picks uniformly among the other online Doors, the current one only when alone", () => {
    expect(chooseNextDoor(["a", "b", "c"], "a", () => 0)).toBe("b");
    expect(chooseNextDoor(["a", "b", "c"], "a", () => 0.99)).toBe("c");
    expect(chooseNextDoor(["a", "b", "c"], "b", () => 0.5)).toBe("c");
    expect(chooseNextDoor(["a"], "a", () => 0.7)).toBe("a");
    expect(chooseNextDoor(["b"], "a", () => 0.7)).toBe("b");
    expect(chooseNextDoor([], "a", () => 0)).toBeNull();
    expect(chooseNextDoor(["a", "b"], null, () => 0.6)).toBe("b");
  });
});

describe("ResidencyController boot", () => {
  it("arrives at the first preferred Door that is online", async () => {
    const world = fakeWorld({ online: ["a", "b", "c"] });
    const { controller } = controllerWith(world, {
      bootPreference: async () => ["z", "c", "b"]
    });
    await controller.begin();
    expect(controller.current?.doorId).toBe("c");
  });

  it("falls back to a random online Door when no preference is online", async () => {
    const world = fakeWorld({ online: ["a", "b"] });
    const { controller } = controllerWith(world, {
      bootPreference: async () => ["z"],
      random: () => 0.9
    });
    await controller.begin();
    expect(controller.current?.doorId).toBe("b");
  });

  it("no Door online: retries with backoff until one appears (never gives up)", async () => {
    const world = fakeWorld({ online: [] });
    let sleeps = 0;
    const { controller, entries } = controllerWith(world, {
      arriveRetryBaseMs: 100,
      arriveRetryMaxMs: 300,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 3) {
          world.online.add("b");
        }
      }
    });
    await controller.begin();
    expect(controller.current?.doorId).toBe("b");
    expect(entries.filter((entry) => entry.msg === "residency_no_door_available")).toHaveLength(3);
  });

  it("a fatal boot error propagates; other arrival errors are retried", async () => {
    const world = fakeWorld({ online: ["a"] });
    let calls = 0;
    const flaky = async (doorId: string): Promise<LiveResidency> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      if (calls === 2) {
        throw new Error("FATAL chain invalid");
      }
      return world.arrive(doorId);
    };
    const { controller } = controllerWith(world, {
      arrive: flaky,
      isFatalBootError: (error) => error instanceof Error && error.message.startsWith("FATAL")
    });
    await expect(controller.begin()).rejects.toThrow(/FATAL/);
    expect(calls).toBe(2);
  });
});

describe("ResidencyController cycle", () => {
  it("timer trigger is off when maxResidencyMs is 0: no interval armed", async () => {
    const world = fakeWorld();
    const timer = new FakeTimer();
    let intervals = 0;
    const countingTimer = {
      setInterval: (handler: () => void, ms: number) => {
        intervals += 1;
        return timer.setInterval(handler, ms);
      },
      clearInterval: (id: unknown) => {
        timer.clearInterval(id);
      }
    };
    const { controller, advance } = controllerWith(world, { timer: countingTimer });
    await controller.begin();
    expect(intervals).toBe(0);
    advance(100 * HOUR);
    controller.checkResidencyAge();
    await Promise.resolve();
    expect(controller.cycling).toBe(false);
  });

  it("timer trigger travels once the residency is older than maxResidencyMs — even a quiet stay", async () => {
    const world = fakeWorld({ online: ["a", "b"] });
    const { controller, timer, advance } = controllerWith(world, {
      maxResidencyMs: 24 * HOUR,
      minMemoryLines: 7,
      bootPreference: async () => ["a"]
    });
    await controller.begin();
    advance(23 * HOUR);
    timer.tick();
    expect(controller.cycling).toBe(false);

    advance(HOUR + 1);
    timer.tick();
    expect(controller.cycling).toBe(true);
    await settle(controller);
    expect(world.events).toEqual(["arrive:a:1", "detach:1", "depart:1", "close:1", "arrive:b:2"]);
    expect(world.residencies[0]?.departRequests).toEqual([{ toDoorId: "b", minMemoryLines: 7 }]);

    // The age clock restarts at arrival.
    timer.tick();
    expect(controller.cycling).toBe(false);
  });

  it("travels to a random other online Door; operator departs form memories from one line", async () => {
    const world = fakeWorld({ online: ["a", "b", "c"] });
    const { controller, entries } = controllerWith(world, {
      bootPreference: async () => ["a"],
      random: () => 0.75
    });
    await controller.begin();

    const outcome = await controller.requestCycle("operator");

    expect(outcome).toEqual({
      kind: "cycled",
      trigger: "operator",
      fromDoor: "a",
      toDoor: "c",
      fromEpoch: 1,
      toEpoch: 2,
      witnessed: 2,
      declined: 1,
      journalPath: "/j/journal-epoch-1.md"
    });
    expect(world.residencies[0]?.departRequests).toEqual([{ toDoorId: "c", minMemoryLines: 1 }]);
    expect(controller.current?.doorId).toBe("c");
    const logged = entries.find((entry) => entry.msg === "residency_cycle_outcome");
    expect(logged?.fields).toMatchObject({
      fromDoor: "a",
      toDoor: "c",
      fromEpoch: 1,
      toEpoch: 2,
      witnessed: 2,
      declined: 1
    });
  });

  it("stays at the current Door when it is the only one online", async () => {
    const world = fakeWorld({ online: ["a"] });
    const { controller } = controllerWith(world);
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({
      kind: "cycled",
      fromDoor: "a",
      toDoor: "a",
      toEpoch: 2
    });
  });

  it("no Door online at departure: travels without to_door_id and arrives once one is back", async () => {
    const world = fakeWorld({ online: ["a"] });
    let sleeps = 0;
    const { controller } = controllerWith(world, {
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) {
          world.online.add("b");
        }
      }
    });
    await controller.begin();
    world.online.clear();

    const outcome = await controller.requestCycle("operator");

    expect(world.residencies[0]?.departRequests).toEqual([{ minMemoryLines: 1 }]);
    expect(outcome).toMatchObject({ kind: "cycled", toDoor: "b", toEpoch: 2 });
  });

  it("single-flight: a second request while cycling resolves busy", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = fakeWorld({
      depart: async (residency) => {
        await gate;
        return departResult(residency.epoch);
      }
    });
    const { controller } = controllerWith(world);
    await controller.begin();
    const pending = controller.requestCycle("operator");
    expect(await controller.requestCycle("operator")).toEqual({
      kind: "busy",
      trigger: "operator"
    });
    expect(await controller.requestCycle("timer")).toEqual({ kind: "busy", trigger: "timer" });
    release?.();
    expect(await pending).toMatchObject({ kind: "cycled", fromEpoch: 1, toEpoch: 2 });
    expect(world.residencies[0]?.departRequests).toHaveLength(1);
  });

  it("detaches before departing (no inbound reaches the departing session)", async () => {
    const world = fakeWorld();
    const { controller } = controllerWith(world);
    await controller.begin();
    await controller.requestCycle("operator");
    expect(world.events.indexOf("detach:1")).toBeLessThan(world.events.indexOf("depart:1"));
  });

  it("retries a failed depart (e.g. witness_unavailable) with backoff, same destination", async () => {
    let failuresLeft = 1;
    const world = fakeWorld({
      depart: async (residency) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("witness_unavailable");
        }
        return departResult(residency.epoch);
      }
    });
    const { controller, delays } = controllerWith(world, { departRetryDelaysMs: [30_000] });
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({ kind: "cycled" });
    const requests = world.residencies[0]?.departRequests ?? [];
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(delays).toEqual([30_000]);
  });

  it("abandon: depart keeps failing → departBare(next) → arrival at the next Door", async () => {
    const world = fakeWorld({
      online: ["a", "b"],
      depart: async () => {
        throw new Error("witness_unavailable");
      }
    });
    const { controller, entries } = controllerWith(world, {
      departRetryDelaysMs: [1, 1],
      bootPreference: async () => ["a"]
    });
    await controller.begin();
    const outcome = await controller.requestCycle("operator");
    expect(outcome).toMatchObject({
      kind: "abandoned",
      fromDoor: "a",
      toDoor: "b",
      fromEpoch: 1,
      toEpoch: 2,
      error: "witness_unavailable"
    });
    expect(world.residencies[0]?.departRequests).toHaveLength(3);
    expect(world.residencies[0]?.bareCalls).toBe(1);
    expect(world.events.slice(-3)).toEqual(["depart_bare:1", "close:1", "arrive:b:2"]);
    expect(entries.some((entry) => entry.msg === "residency_depart_abandoned")).toBe(true);
  });

  it("depart answered epoch_closed: no retry — straight to departBare(next), then arrival", async () => {
    const world = fakeWorld({
      online: ["a", "b"],
      depart: async () => {
        throw DoorError.fromCode("epoch_closed", "residency already departed");
      }
    });
    const { controller, delays } = controllerWith(world, {
      departRetryDelaysMs: [30_000, 120_000],
      bootPreference: async () => ["a"]
    });
    await controller.begin();
    const outcome = await controller.requestCycle("operator");
    expect(outcome).toMatchObject({ kind: "abandoned", fromDoor: "a", toDoor: "b", toEpoch: 2 });
    expect(world.residencies[0]?.departRequests).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(world.residencies[0]?.bareCalls).toBe(1);
    expect(world.events.slice(-3)).toEqual(["depart_bare:1", "close:1", "arrive:b:2"]);
  });

  it("lost_session: no memory attempt — straight to departBare(next), then arrival", async () => {
    const world = fakeWorld({ online: ["a", "b"] });
    const { controller, entries, delays } = controllerWith(world, {
      bootPreference: async () => ["a"]
    });
    await controller.begin();
    const outcome = await controller.requestCycle("lost_session");
    expect(outcome).toMatchObject({
      kind: "abandoned",
      trigger: "lost_session",
      fromDoor: "a",
      toDoor: "b",
      toEpoch: 2
    });
    expect(world.residencies[0]?.departRequests).toHaveLength(0);
    expect(world.residencies[0]?.bareCalls).toBe(1);
    expect(delays).toEqual([]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: "residency_departed_bare",
        fields: { epoch: 1, departure: true }
      })
    );
  });

  it("a failing departBare is logged and the Wanderer still arrives", async () => {
    const world = fakeWorld({
      depart: async () => {
        throw new Error("door unreachable");
      },
      departBare: async () => {
        throw new Error("door unreachable");
      }
    });
    const { controller, entries } = controllerWith(world, { departRetryDelaysMs: [] });
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({
      kind: "abandoned",
      toEpoch: 2
    });
    expect(entries.some((entry) => entry.msg === "residency_depart_bare_failed")).toBe(true);
  });

  it("arrival failure re-probes and retries with backoff at any online Door", async () => {
    const world = fakeWorld({ online: ["a", "b", "c"], arriveFailures: 2 });
    const { controller, delays } = controllerWith(world, {
      arriveRetryBaseMs: 100,
      arriveRetryMaxMs: 150,
      bootPreference: async () => ["a"],
      random: () => 0.99
    });
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({
      kind: "cycled",
      toDoor: "c",
      toEpoch: 2
    });
    expect(delays).toEqual([100, 150]);
    expect(world.arriveCalls).toEqual(["a", "c", "c", "c"]);
  });

  it("shutdown during a depart aborts the cycle and never re-arrives", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = fakeWorld({
      depart: async (residency) => {
        await gate;
        return departResult(residency.epoch);
      }
    });
    const { controller } = controllerWith(world, { shutdownGraceMs: 10 });
    await controller.begin();
    const cycle = controller.requestCycle("operator");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await controller.shutdown();
    expect(world.events).toContain("close:1");
    release?.();
    expect(await cycle).toMatchObject({ kind: "aborted", fromEpoch: 1 });
    expect(world.arriveCalls).toHaveLength(1);
    expect(controller.current).toBeNull();
    expect(await controller.requestCycle("operator")).toMatchObject({ kind: "shutting_down" });
  });

  it("shutdown during the boot arrival closes it and begin rejects", async () => {
    const world = fakeWorld({ online: ["a"] });
    let controller: ResidencyController | null = null;
    const { controller: built } = controllerWith(world, {
      arrive: async (doorId) => {
        const residency = await world.arrive(doorId);
        await controller?.shutdown();
        return residency;
      }
    });
    controller = built;
    await expect(built.begin()).rejects.toThrow(/aborted by shutdown/);
    expect(built.current).toBeNull();
    expect(world.events).toEqual(["arrive:a:1", "close:1"]);
  });

  it("shutdown while waiting to arrive aborts the retry loop", async () => {
    const world = fakeWorld({ arriveFailures: 1_000 });
    const { controller } = controllerWith(world, { sleep: hangingSleep });
    await controller.begin();
    const cycle = controller.requestCycle("operator");
    while (world.arriveCalls.length < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await controller.shutdown();
    expect(await cycle).toMatchObject({ kind: "aborted" });
    expect(world.arriveCalls).toHaveLength(2);
  });

  it("a failing socket close or release never strands the Wanderer between Doors", async () => {
    const world = fakeWorld();
    const flaky = async (doorId: string): Promise<LiveResidency> => {
      const residency = await world.arrive(doorId);
      if (residency.epoch === 1) {
        residency.detach = async () => {
          throw new Error("socket close failed");
        };
        residency.close = async () => {
          throw new Error("drain failed");
        };
      }
      return residency;
    };
    const { controller, entries } = controllerWith(world, { arrive: flaky });
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({ kind: "cycled", toEpoch: 2 });
    expect(entries.map((entry) => entry.msg)).toEqual(
      expect.arrayContaining(["residency_detach_failed", "residency_close_failed"])
    );
  });
});
