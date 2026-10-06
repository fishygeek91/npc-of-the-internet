/**
 * Residency lifecycle through the REAL daemon across several Doors: real door-sdk Doors
 * over HTTP + WebSocket (each with a scripted memory witness), real FileSoulStore,
 * FakeBrain, injected FakeTimer (heartbeats / control-dir polls / residency age).
 *
 * arrive at Door A → conversation → operator-triggered cycle → A witnesses each memory →
 * shard / rejected / journal / departure / travel(→ B) records → arrival at Door B at
 * epoch + 1 → the chain verifies with both Door keys.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { OutboundFrameSchema, type OutboundFrame } from "@npc/door-sdk";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { FakeBrain } from "../src/brain/fake-brain.js";
import type { BrainMessage } from "../src/brain/types.js";
import { startResidencyDaemon, type ResidencyDaemonHandle } from "../src/daemon.js";
import { DISTILLER_SYSTEM } from "../src/prompts/distiller/system.js";
import { JOURNAL_SYSTEM } from "../src/prompts/journal/system.js";
import { writeDepartRequest } from "../src/residency/control-dir.js";
import { ScriptedWitness } from "./helpers/door-stub.js";
import { FakeTimer } from "./helpers/fake-timer.js";
import { DOOR, OTHER_DOOR, THIRD_DOOR } from "./helpers/fixed-keys.js";
import {
  capturingLogger,
  chainShape,
  createSoulDirs,
  multiDoorConfig,
  OffsetClock,
  readVerifiedChain,
  startTestDoor,
  waitFor,
  type TestDoor
} from "./helpers/test-doors.js";

const A = "discord:a";
const B = "web:b";
const KEYS = { [A]: DOOR.publicKey, [B]: OTHER_DOOR.publicKey };
const RAW_LINE = "my cat is named Pixel and she hates thunder";
const GAP_LINE = "anyone here? (said during the travel gap)";
const JOURNAL = "# Journal\n\nThe storms followed me here, and then I left.";
const SHARDS = [
  "I remember the guild talking about storms.",
  "I remember a cat that hates thunder.",
  "I remember the river running high."
];

const silent = pino({ level: "silent" });

/** Brain: distiller → shards JSON, journal → markdown, otherwise echo the user line. */
function lifecycleBrain(gate?: Promise<void>): FakeBrain {
  return new FakeBrain(async (messages: BrainMessage[]) => {
    const system = messages[0]?.content ?? "";
    if (system === DISTILLER_SYSTEM) {
      await gate;
      return JSON.stringify({ shards: SHARDS.map((text) => ({ text })) });
    }
    if (system === JOURNAL_SYSTEM) {
      return JOURNAL;
    }
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    return `echo:${lastUser?.content ?? ""}`;
  });
}

function distilled(brain: FakeBrain): boolean {
  return brain.calls.some((call) => call.messages[0]?.content === DISTILLER_SYSTEM);
}

/** Collect outbound frames from every session socket a Door accepts. */
function collectOutbound(door: TestDoor): { frames: OutboundFrame[]; watch: () => void } {
  const frames: OutboundFrame[] = [];
  const watched = new Set<WebSocket>();
  return {
    frames,
    watch: () => {
      for (const socket of door.wsServer.getActiveClients()) {
        if (watched.has(socket)) continue;
        watched.add(socket);
        socket.on("message", (data: WebSocket.RawData) => {
          const text = typeof data === "string" ? data : data.toString("utf8");
          frames.push(OutboundFrameSchema.parse(JSON.parse(text)));
        });
      }
    }
  };
}

/** Every file under `dir` (recursively) as UTF-8 text. */
async function allFileText(dir: string): Promise<string> {
  let out = "";
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      out += await readFile(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return out;
}

function withoutHeartbeats(shape: readonly string[]): string[] {
  return shape.filter((entry) => entry !== "heartbeat");
}

describe("residency lifecycle (daemon, multi-Door)", () => {
  const doors: TestDoor[] = [];
  let handle: ResidencyDaemonHandle | null = null;

  async function door(
    doorId: string,
    keypair: typeof DOOR,
    options: Omit<Parameters<typeof startTestDoor>[0], "doorId" | "keypair"> = {}
  ): Promise<TestDoor> {
    const started = await startTestDoor({ doorId, keypair, ...options });
    doors.push(started);
    return started;
  }

  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
    for (const started of doors.splice(0)) {
      await started.stop();
    }
  });

  it("operator depart → witnessed memories at A → travel → arrival at B; chain verifies", async () => {
    const dirs = await createSoulDirs("npc-multi-");
    const witnessA = new ScriptedWitness((input) =>
      input.text === SHARDS[1] ? { witnessed: false, reason: "private" } : { witnessed: true }
    );
    const a = await door(A, DOOR, { witness: witnessA });
    const b = await door(B, OTHER_DOOR);
    const timer = new FakeTimer();
    let releaseDistill: (() => void) | undefined;
    const distillGate = new Promise<void>((resolve) => {
      releaseDistill = resolve;
    });
    const brain = lifecycleBrain(distillGate);
    const outA = collectOutbound(a);
    const outB = collectOutbound(b);

    handle = await startResidencyDaemon(
      multiDoorConfig({ dirs, doors: [a, b], doorPublicKeys: KEYS, preferredDoorId: A }),
      { brain, timer, logger: silent, skipSignals: true }
    );
    const daemon = handle;
    expect(daemon.currentDoorId()).toBe(A);
    expect(daemon.currentEpoch()).toBe(1);
    await waitFor(() => a.wsServer.getActiveClients().size === 1, "socket at A");
    outA.watch();

    for (const [i, text] of [RAW_LINE, "storms again tonight", "the river is high"].entries()) {
      a.wsServer.broadcastInbound({ text, author_id: `u${String(i)}` }, `in-1-${String(i)}`);
    }
    await waitFor(() => outA.frames.length === 3, "three replies");

    // Operator: `wanderer depart` drops a request; the daemon's poll picks it up.
    await writeDepartRequest(dirs.controlDir, new Date().toISOString());
    timer.tick();
    await waitFor(() => distilled(brain), "distill");

    // Travel gap: the old socket is closed; a message now reaches no session.
    await waitFor(() => a.wsServer.getActiveClients().size === 0, "socket detached");
    a.wsServer.broadcastInbound({ text: GAP_LINE, author_id: "u9" }, "in-gap");
    releaseDistill?.();

    await waitFor(() => daemon.currentDoorId() === B, "arrival at B");
    expect(daemon.currentEpoch()).toBe(2);
    await waitFor(() => b.wsServer.getActiveClients().size === 1, "socket at B");
    outB.watch();
    b.wsServer.broadcastInbound({ text: "welcome", author_id: "v1" }, "in-2-0");
    await waitFor(() => outB.frames.length === 1, "reply at B");
    expect(outB.frames[0]).toMatchObject({ door_id: B, epoch: 2, body: { text: "echo:welcome" } });

    await daemon.shutdown();
    handle = null;

    const records = await readVerifiedChain(dirs.chainDir, KEYS);
    expect(withoutHeartbeats(chainShape(records))).toEqual([
      `arrival:${A}:1`,
      "memory/shard",
      "memory/rejected:witness_private",
      "memory/shard",
      "memory/journal",
      `departure:${A}:1`,
      `travel:${A}->${B}`,
      `arrival:${B}:2`
    ]);

    // A judged each memory against its OWN record of the stay (both sides of the talk).
    expect(witnessA.texts("shard")).toEqual(SHARDS);
    expect(witnessA.texts("journal")).toEqual([JOURNAL]);
    const record = witnessA.calls[0]?.transcript.map((line) => line.text) ?? [];
    expect(record).toContain(RAW_LINE);
    expect(record).toContain(`echo:${RAW_LINE}`);
    // The Wanderer itself never heard the travel-gap line.
    expect(
      brain.calls.some((call) => call.messages.some((m) => m.content.includes(GAP_LINE)))
    ).toBe(false);

    // Journal published; raw conversation and the declined memory never touch disk.
    const journals = await readdir(dirs.journalDir);
    expect(journals).toEqual(["journal-discord_a-epoch-1.md"]);
    const disk = await allFileText(dirs.root);
    expect(disk).not.toContain(RAW_LINE);
    expect(disk).not.toContain(SHARDS[1]);
  });

  it("boot prefers the Door of the chain's last arrival over CURRENT_DOOR_ID", async () => {
    const dirs = await createSoulDirs("npc-boot-pref-");
    const a = await door(A, DOOR);
    const b = await door(B, OTHER_DOOR);
    const config = multiDoorConfig({
      dirs,
      doors: [a, b],
      doorPublicKeys: KEYS,
      preferredDoorId: A
    });

    handle = await startResidencyDaemon(config, {
      brain: lifecycleBrain(),
      timer: new FakeTimer(),
      logger: silent,
      skipSignals: true
    });
    expect(handle.currentDoorId()).toBe(A);
    expect(await handle.requestCycle("operator")).toMatchObject({
      kind: "cycled",
      fromDoor: A,
      toDoor: B
    });
    await handle.shutdown();

    // Restart (crash-style, no departure): back to B, where the chain says it is.
    handle = await startResidencyDaemon(config, {
      brain: lifecycleBrain(),
      timer: new FakeTimer(),
      logger: silent,
      skipSignals: true
    });
    expect(handle.currentDoorId()).toBe(B);
    expect(handle.currentEpoch()).toBe(3);
  });

  it("a Door whose pubkey differs from ATLAS_DOOR_PUBKEYS is rejected and never visited", async () => {
    const dirs = await createSoulDirs("npc-rogue-");
    const rogue = await door(A, THIRD_DOOR);
    const b = await door(B, OTHER_DOOR);
    const { logger, lines } = capturingLogger();

    handle = await startResidencyDaemon(
      multiDoorConfig({ dirs, doors: [rogue, b], doorPublicKeys: KEYS, preferredDoorId: A }),
      { brain: lifecycleBrain(), timer: new FakeTimer(), logger, skipSignals: true }
    );

    expect(handle.currentDoorId()).toBe(B);
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "door_rejected",
        door_id: A,
        reason: "door_pubkey differs from ATLAS_DOOR_PUBKEYS"
      })
    );
    // B is the only trusted Door online: the Wanderer stays there.
    expect(await handle.requestCycle("operator")).toMatchObject({ toDoor: B, toEpoch: 2 });
    expect(rogue.door.getLastKnownEpoch()).toBeNull();
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "residency_lifecycle_config",
        doors: [rogue.baseUrl, b.baseUrl],
        maxResidencyMs: 0,
        minLines: 10,
        operatorTrigger: true
      })
    );
  });

  it("a Door without attest.memory: no distill, no memory records — the Wanderer still travels", async () => {
    const dirs = await createSoulDirs("npc-nowitness-");
    const a = await door(A, DOOR, { witness: null });
    const b = await door(B, OTHER_DOOR);
    const brain = lifecycleBrain();
    handle = await startResidencyDaemon(
      multiDoorConfig({ dirs, doors: [a, b], doorPublicKeys: KEYS, preferredDoorId: A }),
      { brain, timer: new FakeTimer(), logger: silent, skipSignals: true }
    );
    await waitFor(() => a.wsServer.getActiveClients().size === 1, "socket at A");
    for (let i = 0; i < 12; i += 1) {
      a.wsServer.broadcastInbound(
        { text: `line ${String(i)}`, author_id: "u1" },
        `in-${String(i)}`
      );
    }
    await waitFor(() => brain.calls.length === 12, "replies");

    expect(await handle.requestCycle("timer")).toMatchObject({
      kind: "cycled",
      toDoor: B,
      witnessed: 0
    });
    await handle.shutdown();
    handle = null;

    expect(distilled(brain)).toBe(false);
    expect(withoutHeartbeats(chainShape(await readVerifiedChain(dirs.chainDir, KEYS)))).toEqual([
      `arrival:${A}:1`,
      `departure:${A}:1`,
      `travel:${A}->${B}`,
      `arrival:${B}:2`
    ]);
  });

  it("the daily timer travels even after a quiet stay (no memories, no distill)", async () => {
    const dirs = await createSoulDirs("npc-timer-");
    const clock = new OffsetClock();
    const a = await door(A, DOOR, { clock });
    const b = await door(B, OTHER_DOOR, { clock });
    const timer = new FakeTimer();
    const brain = lifecycleBrain();
    handle = await startResidencyDaemon(
      multiDoorConfig({
        dirs,
        doors: [a, b],
        doorPublicKeys: KEYS,
        preferredDoorId: A,
        residency: { maxResidencyMs: 86_400_000 }
      }),
      { brain, timer, clock, logger: silent, skipSignals: true }
    );
    const daemon = handle;
    await waitFor(() => a.wsServer.getActiveClients().size === 1, "socket at A");
    a.wsServer.broadcastInbound({ text: "hello?", author_id: "u1" }, "in-1");
    await waitFor(() => brain.calls.length === 1, "reply");

    timer.tick();
    expect(daemon.currentDoorId()).toBe(A);
    clock.offsetMs = 86_400_000 + 60_000;
    timer.tick();
    await waitFor(() => daemon.currentDoorId() === B, "timer travel");

    expect(distilled(brain)).toBe(false);
    expect(a.witness?.calls).toHaveLength(0);
  });

  it("no Door online at boot: retries with backoff until one answers", async () => {
    const dirs = await createSoulDirs("npc-offline-");
    const a = await door(A, DOOR);
    a.available = false;
    const { logger, lines } = capturingLogger();
    const sleeps: number[] = [];
    handle = await startResidencyDaemon(
      multiDoorConfig({ dirs, doors: [a], doorPublicKeys: KEYS }),
      {
        brain: lifecycleBrain(),
        timer: new FakeTimer(),
        logger,
        skipSignals: true,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 2) {
            a.available = true;
          }
        }
      }
    );
    expect(handle.currentDoorId()).toBe(A);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(lines.filter((line) => line.msg === "residency_no_door_available")).toHaveLength(2);
    expect(lines.some((line) => line.msg === "door_probe_failed")).toBe(true);
  });

  it("SIGUSR2 (operator trigger on by default) travels; listeners are removed on shutdown", async () => {
    const dirs = await createSoulDirs("npc-sigusr2-");
    const a = await door(A, DOOR);
    const b = await door(B, OTHER_DOOR);
    const before = process.listenerCount("SIGUSR2");
    const beforeTerm = process.listenerCount("SIGTERM");
    handle = await startResidencyDaemon(
      multiDoorConfig({ dirs, doors: [a, b], doorPublicKeys: KEYS, preferredDoorId: A }),
      { brain: lifecycleBrain(), timer: new FakeTimer(), logger: silent, skipSignals: false }
    );
    const daemon = handle;
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);

    process.kill(process.pid, "SIGUSR2");
    await waitFor(() => daemon.currentDoorId() === B, "travel after SIGUSR2");

    await daemon.shutdown();
    handle = null;
    expect(process.listenerCount("SIGUSR2")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("with the operator trigger and timer off nothing departs on its own", async () => {
    const dirs = await createSoulDirs("npc-off-");
    const a = await door(A, DOOR);
    const b = await door(B, OTHER_DOOR);
    const timer = new FakeTimer();
    const before = process.listenerCount("SIGUSR2");
    handle = await startResidencyDaemon(
      multiDoorConfig({
        dirs,
        doors: [a, b],
        doorPublicKeys: KEYS,
        preferredDoorId: A,
        residency: { operatorTrigger: false, maxResidencyMs: 0 }
      }),
      { brain: lifecycleBrain(), timer, logger: silent, skipSignals: false }
    );
    // SIGUSR2 is still handled (ignored) so a stray signal cannot kill the daemon.
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
    process.kill(process.pid, "SIGUSR2");
    await writeDepartRequest(dirs.controlDir, new Date().toISOString());
    for (let i = 0; i < 5; i += 1) timer.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(handle.currentDoorId()).toBe(A);
    expect(handle.currentEpoch()).toBe(1);
    // The request is left for no one (Ghost: tmpfs, cleared on restart).
    await readFile(join(dirs.controlDir, "depart.request"), "utf8");
  });
});
