import { describe, expect, it } from "vitest";

import type { CommitQuarantineResult } from "../src/quarantine/commit.js";
import {
  ResidencyController,
  type AbortableSleep,
  type CommitDepartedEpoch,
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

function departResult(epoch: number, candidates = 2): DepartResult {
  return {
    journalPath: `/j/journal-epoch-${String(epoch)}.md`,
    journalMarkdown: `# epoch ${String(epoch)}`,
    approvedShardIds: Array.from({ length: candidates }, (_, i) => `s${String(i)}`),
    rejectedShardIds: [],
    candidateCids: Array.from({ length: candidates }, (_, i) => `c${String(i)}`)
  };
}

type FakeResidency = LiveResidency & { lines: number; departCalls: number };

/** World of fake residencies; `events` records lifecycle order across them. */
function fakeWorld(opts: {
  lines?: number;
  depart?: (residency: FakeResidency) => Promise<DepartResult>;
  arriveFailures?: number;
}) {
  const events: string[] = [];
  const residencies: FakeResidency[] = [];
  let nextEpoch = 1;
  let arriveFailures = opts.arriveFailures ?? 0;
  let arriveCalls = 0;
  const arrive = async (): Promise<LiveResidency> => {
    arriveCalls += 1;
    if (residencies.length > 0 && arriveFailures > 0) {
      arriveFailures -= 1;
      events.push("arrive:failed");
      throw new Error("door unavailable");
    }
    const epoch = nextEpoch;
    nextEpoch += 1;
    const residency: FakeResidency = {
      epoch,
      lines: opts.lines ?? 12,
      departCalls: 0,
      transcriptSize: () => residency.lines,
      detach: async () => {
        events.push(`detach:${String(epoch)}`);
      },
      depart: async () => {
        residency.departCalls += 1;
        events.push(`depart:${String(epoch)}`);
        return opts.depart !== undefined ? opts.depart(residency) : departResult(epoch);
      },
      close: async () => {
        events.push(`close:${String(epoch)}`);
      }
    };
    residencies.push(residency);
    events.push(`arrive:${String(epoch)}`);
    return residency;
  };
  return {
    events,
    residencies,
    arrive,
    arriveCalls: () => arriveCalls
  };
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

function controllerWith(
  world: ReturnType<typeof fakeWorld>,
  overrides: Partial<ResidencyControllerOptions> = {}
) {
  const timer = new FakeTimer();
  let now = 1_000_000;
  const { logger, entries } = recordingLogger();
  const { sleep, delays } = instantSleep();
  const controller = new ResidencyController({
    arrive: world.arrive,
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

describe("ResidencyController", () => {
  it("timer trigger is off by default: no interval armed, no cycle however old", async () => {
    const world = fakeWorld({});
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
    timer.tick();
    await Promise.resolve();
    expect(world.arriveCalls()).toBe(1);
    expect(controller.cycling).toBe(false);
  });

  it("timer trigger cycles once the residency exceeds NPC_RESIDENCY_MAX_MS", async () => {
    const world = fakeWorld({});
    const { controller, timer, advance } = controllerWith(world, { maxResidencyMs: 2 * HOUR });
    await controller.begin();
    advance(HOUR);
    timer.tick();
    expect(controller.cycling).toBe(false);

    advance(HOUR + 1);
    timer.tick();
    expect(controller.cycling).toBe(true);
    while (controller.cycling) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(world.events).toEqual(["arrive:1", "detach:1", "depart:1", "close:1", "arrive:2"]);
    expect(controller.current?.epoch).toBe(2);

    // The age clock restarts at re-arrival.
    timer.tick();
    expect(controller.cycling).toBe(false);
  });

  it("timer trigger waits for enough conversation; the operator trigger needs one line", async () => {
    const world = fakeWorld({ lines: 3 });
    const { controller, entries } = controllerWith(world, {
      maxResidencyMs: HOUR,
      timerMinTranscriptLines: 10
    });
    await controller.begin();
    const first = await controller.requestCycle("timer");
    expect(first).toMatchObject({ kind: "skipped", reason: "transcript_too_short", lines: 3 });
    await controller.requestCycle("timer");
    // Logged once per residency, not every minute.
    expect(entries.filter((entry) => entry.msg === "residency_cycle_skipped")).toHaveLength(1);

    const residency = world.residencies[0];
    if (residency === undefined) throw new Error("no residency");
    residency.lines = 0;
    expect(await controller.requestCycle("operator")).toMatchObject({ kind: "skipped" });
    residency.lines = 1;
    expect(await controller.requestCycle("operator")).toMatchObject({
      kind: "cycled",
      fromEpoch: 1,
      toEpoch: 2
    });
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
    const first = controller.requestCycle("operator");
    expect(await controller.requestCycle("operator")).toEqual({
      kind: "busy",
      trigger: "operator"
    });
    expect(await controller.requestCycle("timer")).toEqual({ kind: "busy", trigger: "timer" });
    release?.();
    expect(await first).toMatchObject({ kind: "cycled", fromEpoch: 1, toEpoch: 2 });
    expect(world.residencies[0]?.departCalls).toBe(1);
  });

  it("detaches before departing (no inbound reaches the departing session)", async () => {
    const world = fakeWorld({});
    const { controller } = controllerWith(world);
    await controller.begin();
    await controller.requestCycle("operator");
    expect(world.events.indexOf("detach:1")).toBeLessThan(world.events.indexOf("depart:1"));
  });

  it("retries a failed depart (Bug #69 retryable) with backoff", async () => {
    let failuresLeft = 1;
    const world = fakeWorld({
      depart: async (residency) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("review timed out");
        }
        return departResult(residency.epoch);
      }
    });
    const { controller, delays } = controllerWith(world, { departRetryDelaysMs: [30_000] });
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({ kind: "cycled" });
    expect(world.residencies[0]?.departCalls).toBe(2);
    expect(delays).toEqual([30_000]);
  });

  it("abandons a depart that keeps failing and still re-arrives (crash-style)", async () => {
    const world = fakeWorld({
      depart: async () => {
        throw new Error("distillation produced fewer than 5 usable shards");
      }
    });
    const { controller, entries } = controllerWith(world, { departRetryDelaysMs: [1, 1] });
    await controller.begin();
    const outcome = await controller.requestCycle("operator");
    expect(outcome).toMatchObject({ kind: "abandoned", fromEpoch: 1, toEpoch: 2 });
    expect(world.residencies[0]?.departCalls).toBe(3);
    expect(world.events).toContain("close:1");
    expect(entries.some((entry) => entry.msg === "residency_depart_abandoned")).toBe(true);
    expect(controller.current?.epoch).toBe(2);
  });

  it("retries re-arrival until the Door is back", async () => {
    const world = fakeWorld({ arriveFailures: 2 });
    const { controller, delays } = controllerWith(world, {
      arriveRetryBaseMs: 100,
      arriveRetryMaxMs: 150
    });
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({ kind: "cycled", toEpoch: 2 });
    expect(delays).toEqual([100, 150]);
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
    expect(world.arriveCalls()).toBe(1);
    expect(controller.current).toBeNull();
    expect(await controller.requestCycle("operator")).toMatchObject({ kind: "shutting_down" });
  });

  it("shutdown while waiting to re-arrive aborts the retry loop", async () => {
    const world = fakeWorld({ arriveFailures: 1_000 });
    const { controller } = controllerWith(world, { sleep: hangingSleep });
    await controller.begin();
    const cycle = controller.requestCycle("operator");
    while (world.arriveCalls() < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await controller.shutdown();
    expect(await cycle).toMatchObject({ kind: "aborted" });
    expect(world.arriveCalls()).toBe(2);
  });

  it("commit sweep runs between departure and re-arrival, attaching the journal once", async () => {
    const world = fakeWorld({});
    const calls: Array<{ epoch: number; journalMarkdown?: string }> = [];
    const results: CommitQuarantineResult[] = [
      { committedCids: [], ripeningCids: ["c0", "c1"], skippedCids: [], journalAttached: false },
      { committedCids: ["s0"], ripeningCids: ["c1"], skippedCids: [], journalAttached: true },
      { committedCids: ["s1"], ripeningCids: [], skippedCids: [], journalAttached: false }
    ];
    const commit: CommitDepartedEpoch = async (args) => {
      calls.push(args);
      world.events.push(`commit:${String(args.epoch)}`);
      const next = results.shift();
      if (next === undefined) throw new Error("unexpected commit");
      return next;
    };
    const { controller, delays } = controllerWith(world, {
      commit,
      commitIntervalMs: 10_000,
      quarantineWindowMs: 60_000
    });
    await controller.begin();
    const outcome = await controller.requestCycle("operator");
    expect(outcome).toMatchObject({ kind: "cycled", committedCount: 2, candidateCount: 2 });
    expect(calls.map((call) => call.journalMarkdown)).toEqual([
      "# epoch 1",
      "# epoch 1",
      undefined
    ]);
    expect(calls.every((call) => call.epoch === 1)).toBe(true);
    expect(delays).toEqual([10_000, 10_000, 10_000]);
    expect(world.events).toEqual([
      "arrive:1",
      "detach:1",
      "depart:1",
      "close:1",
      "commit:1",
      "commit:1",
      "commit:1",
      "arrive:2"
    ]);
  });

  it("commit sweep gives up after consecutive failures and still re-arrives", async () => {
    const world = fakeWorld({});
    let commitCalls = 0;
    const { controller, entries } = controllerWith(world, {
      commit: async () => {
        commitCalls += 1;
        throw new Error("review_pending: cosign review not completed for this epoch");
      },
      commitIntervalMs: 10_000,
      quarantineWindowMs: 60_000,
      commitMaxFailures: 3
    });
    await controller.begin();
    expect(await controller.requestCycle("operator")).toMatchObject({
      kind: "cycled",
      committedCount: 0,
      toEpoch: 2
    });
    expect(commitCalls).toBe(3);
    expect(entries.some((entry) => entry.msg === "residency_commit_sweep_abandoned")).toBe(true);
  });

  it("skips the commit sweep when it is disabled or nothing was approved", async () => {
    const world = fakeWorld({ depart: async (residency) => departResult(residency.epoch, 0) });
    let commitCalls = 0;
    const { controller } = controllerWith(world, {
      commit: async () => {
        commitCalls += 1;
        return { committedCids: [], ripeningCids: [], skippedCids: [], journalAttached: false };
      },
      commitIntervalMs: 10_000
    });
    await controller.begin();
    await controller.requestCycle("operator");
    expect(commitCalls).toBe(0);
    expect(
      () => new ResidencyController({ ...baseOptions(world), commit: async () => results0() })
    ).toThrow(/commitIntervalMs/);
  });
});

function results0(): CommitQuarantineResult {
  return { committedCids: [], ripeningCids: [], skippedCids: [], journalAttached: false };
}

function baseOptions(world: ReturnType<typeof fakeWorld>): ResidencyControllerOptions {
  return {
    arrive: world.arrive,
    maxResidencyMs: 0,
    nowMs: () => 0,
    timer: new FakeTimer(),
    sleep: async () => undefined,
    logger: recordingLogger().logger
  };
}

describe("ResidencyController release failures", () => {
  it("a failing socket close or release never strands the Wanderer between Doors", async () => {
    const world = fakeWorld({});
    const flaky = async (): Promise<LiveResidency> => {
      const residency = await world.arrive();
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
