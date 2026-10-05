/**
 * Residency lifecycle through the REAL daemon: real door-sdk Door over HTTP + WebSocket,
 * real FileSoulStore, FakeBrain, injected FakeTimer (heartbeats / control-dir polls).
 *
 * arrive → inbound → operator-triggered cycle (control dir / SIGUSR2) → Door review →
 * candidate / departure / travel records → re-arrival at epoch + 1 → heartbeats and
 * inbound continue on the new session → chain verifies with the Door key.
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Door,
  HttpDoorServer,
  OutboundFrameSchema,
  WsDoorSessionServer,
  type HostPolicy,
  type OutboundFrame
} from "@npc/door-sdk";
import {
  OSP_SPEC_V02,
  createRecord,
  encodeBase64Url,
  encodePublicKey,
  FileSoulStore,
  verifyChain,
  type OspRecord
} from "@npc/osp-core";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { FakeBrain } from "../src/brain/fake-brain.js";
import type { BrainMessage } from "../src/brain/types.js";
import type { DaemonConfig } from "../src/daemon-config.js";
import { startResidencyDaemon, type ResidencyDaemonHandle } from "../src/daemon.js";
import { DISTILLER_SYSTEM } from "../src/prompts/distiller/system.js";
import { JOURNAL_SYSTEM } from "../src/prompts/journal/system.js";
import { loadReplicationConfig } from "../src/replication/config.js";
import { loadResidencyConfig, type ResidencyConfig } from "../src/residency/config.js";
import { writeDepartRequest } from "../src/residency/control-dir.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { FakeTimer } from "./helpers/fake-timer.js";

const DOOR_ID = "discord:residency-test";
const DOOR_KEYS = { [DOOR_ID]: DOOR.publicKey };
const RAW_LINE = "my cat is named Pixel and she hates thunder";
const GAP_LINE = "anyone here? (said during the travel gap)";

const policy: HostPolicy = {
  community: {
    name: "Residency Test Guild",
    description: "Residency lifecycle integration tests.",
    platform: "discord",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
};

const SHARDS = Array.from({ length: 6 }, (_, i) => ({
  text: `I remember the guild talking about storms, part ${String(i + 1)}.`
}));

type Env = {
  chainDir: string;
  controlDir: string;
  journalDir: string;
  readyFilePath: string;
  door: Door;
  httpServer: HttpDoorServer;
  wsServer: WsDoorSessionServer;
  config: (residency?: Partial<ResidencyConfig>) => DaemonConfig;
};

/** Wall clock with a test-controlled offset, shared by the Door and the daemon. */
class OffsetClock {
  offsetMs = 0;
  now(): string {
    return new Date(Date.now() + this.offsetMs).toISOString();
  }
}

async function createEnv(opts: { pastEpochs?: boolean; clock?: OffsetClock } = {}): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "npc-residency-"));
  const chainDir = join(root, "chain");
  const soulKeyPath = join(root, "soul.key");
  await writeFile(soulKeyPath, encodeBase64Url(SOUL.privateKey), "utf8");

  const store = await FileSoulStore.open(chainDir, { doorPublicKeys: DOOR_KEYS });
  const genesis = await createRecord({
    spec: OSP_SPEC_V02,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nResidency lifecycle test.",
      soul_pubkey: encodePublicKey(SOUL.publicKey),
      created_at: "2026-10-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: SOUL.privateKey
  });
  await store.append(genesis.record);
  await store.close();

  const door = new Door({
    doorId: DOOR_ID,
    doorKeypair: DOOR,
    soulPublicKey: SOUL.publicKey,
    clock: opts.clock ?? { now: () => new Date().toISOString() },
    policy:
      opts.pastEpochs === true
        ? { ...policy, capabilities: [...policy.capabilities, "cosign.past_epochs"] }
        : policy
  });
  const httpServer = new HttpDoorServer({ door });
  const httpInfo = await httpServer.start();
  const wsServer = new WsDoorSessionServer({ door, server: httpServer.nodeServer });
  await wsServer.start();
  const url = new URL(httpInfo.baseUrl);

  const controlDir = join(root, "control");
  const journalDir = join(root, "published", "journals");
  const readyFilePath = join(root, "ready");
  return {
    chainDir,
    controlDir,
    journalDir,
    readyFilePath,
    door,
    httpServer,
    wsServer,
    config: (residency = {}) => ({
      soulKeyPath,
      soulchainDir: chainDir,
      doorHttpHost: url.hostname,
      doorHttpPort: Number.parseInt(url.port, 10),
      doorId: DOOR_ID,
      doorPublicKeys: DOOR_KEYS,
      brain: { apiKey: "test", model: "test-model", maxTokens: 1024, timeoutMs: 60_000 },
      readyFilePath,
      replication: loadReplicationConfig({}),
      attentionMode: "always",
      residency: {
        ...loadResidencyConfig({}),
        controlDir,
        journalDir,
        ...residency
      }
    })
  };
}

/** Brain: distiller → shards JSON, journal → markdown, otherwise echo the user line. */
function lifecycleBrain(gate?: Promise<void>): FakeBrain {
  return new FakeBrain(async (messages: BrainMessage[]) => {
    const system = messages[0]?.content ?? "";
    if (system === DISTILLER_SYSTEM) {
      await gate;
      return JSON.stringify({ shards: SHARDS });
    }
    if (system === JOURNAL_SYSTEM) {
      return "# Journal\n\nThe storms followed me here, and then I left.";
    }
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    return `echo:${lastUser?.content ?? ""}`;
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > 8_000) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Collect outbound frames from every session socket the Door accepts. */
function collectOutbound(wsServer: WsDoorSessionServer): {
  frames: OutboundFrame[];
  watch: () => void;
} {
  const frames: OutboundFrame[] = [];
  const watched = new Set<WebSocket>();
  return {
    frames,
    watch: () => {
      for (const socket of wsServer.getActiveClients()) {
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

async function readChain(chainDir: string): Promise<OspRecord[]> {
  const store = await FileSoulStore.open(chainDir, { doorPublicKeys: DOOR_KEYS });
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) records.push(record);
  const verified = await verifyChain(store, { doorPublicKeys: DOOR_KEYS });
  expect(verified.valid).toBe(true);
  await store.close();
  return records;
}

function attestations(records: readonly OspRecord[]): string[] {
  return records.flatMap((record) => {
    if (record.type !== "attestation") return [];
    const body = record.body as { kind: string; epoch?: number; from_epoch?: number };
    return [`${body.kind}:${String(body.epoch ?? body.from_epoch)}`];
  });
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

describe("residency lifecycle (daemon)", () => {
  let env: Env;
  let handle: ResidencyDaemonHandle | null = null;

  beforeEach(async () => {
    env = await createEnv();
  });

  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
    await env.wsServer.stop();
    await env.httpServer.stop();
  });

  it("operator depart request → review → records → re-arrival at epoch+1; chain verifies", async () => {
    const timer = new FakeTimer();
    let releaseDistill: (() => void) | undefined;
    const distillGate = new Promise<void>((resolve) => {
      releaseDistill = resolve;
    });
    const brain = lifecycleBrain(distillGate);
    const outbound = collectOutbound(env.wsServer);
    handle = await startResidencyDaemon(env.config({ operatorTrigger: true }), {
      brain,
      timer,
      logger: pino({ level: "silent" }),
      skipSignals: true
    });
    const daemon = handle;
    expect(daemon.currentEpoch()).toBe(1);
    await waitFor(() => env.wsServer.getActiveClients().size === 1, "first socket");
    outbound.watch();

    // Residency 1: three inbound lines + a heartbeat.
    for (const [i, text] of [RAW_LINE, "storms again tonight", "the river is high"].entries()) {
      env.wsServer.broadcastInbound({ text, author_id: `u${String(i)}` }, `in-1-${String(i)}`);
    }
    await waitFor(() => outbound.frames.length === 3, "three replies");
    expect(outbound.frames.every((frame) => frame.epoch === 1)).toBe(true);
    timer.tick();
    await waitFor(
      async () =>
        (await readFile(join(env.chainDir, "chain.jsonl"), "utf8")).includes('"heartbeat"'),
      "heartbeat 1"
    );

    // Operator: `wanderer depart` drops a request; the daemon's poll picks it up.
    await writeDepartRequest(env.controlDir, new Date().toISOString());
    timer.tick();
    await waitFor(
      () => brain.calls.some((call) => call.messages[0]?.content === DISTILLER_SYSTEM),
      "distill"
    );

    // Travel gap: the old socket is closed; a message now reaches no session.
    expect(daemon.currentEpoch()).toBe(1);
    await waitFor(() => env.wsServer.getActiveClients().size === 0, "socket detached");
    await expect(readFile(env.readyFilePath, "utf8")).rejects.toThrow();
    env.wsServer.broadcastInbound({ text: GAP_LINE, author_id: "u9" }, "in-gap");
    releaseDistill?.();

    await waitFor(() => daemon.currentEpoch() === 2, "re-arrival");
    await waitFor(() => env.wsServer.getActiveClients().size === 1, "second socket");
    await readFile(env.readyFilePath, "utf8");
    outbound.watch();

    // Residency 2: a fresh session (no carried history), heartbeats continue.
    env.wsServer.broadcastInbound({ text: "welcome back", author_id: "u1" }, "in-2-0");
    await waitFor(() => outbound.frames.length === 4, "reply in epoch 2");
    expect(outbound.frames[3]).toMatchObject({ epoch: 2, body: { text: "echo:welcome back" } });
    const lastCall = brain.calls[brain.calls.length - 1];
    expect(lastCall?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(
      brain.calls.some((call) =>
        call.messages.some((message) => message.content.includes(GAP_LINE))
      )
    ).toBe(false);
    timer.tick();
    await waitFor(async () => {
      const chain = await readFile(join(env.chainDir, "chain.jsonl"), "utf8");
      return chain.split("\n").filter((line) => line.includes('"heartbeat"')).length === 2;
    }, "heartbeat 2");

    await daemon.shutdown();
    handle = null;

    const records = await readChain(env.chainDir);
    expect(attestations(records)).toEqual([
      "arrival:1",
      "heartbeat:1",
      // The tick that polled the control dir also fired a heartbeat (one FakeTimer).
      "heartbeat:1",
      "departure:1",
      "travel:1",
      "arrival:2",
      "heartbeat:2"
    ]);
    const travel = records.find(
      (record) => record.type === "attestation" && record.body.kind === "travel"
    );
    expect(travel?.body).toMatchObject({ from_door_id: DOOR_ID, to_door_id: DOOR_ID });
    const candidates = records.filter(
      (record) => record.type === "memory" && record.body.kind === "candidate"
    );
    expect(candidates).toHaveLength(SHARDS.length);
    expect(candidates.every((record) => record.residency === `door:${DOOR_ID}/epoch:1`)).toBe(true);

    // Journal published to NPC_JOURNAL_DIR; the raw transcript never touched disk.
    const journals = await readdir(env.journalDir);
    expect(journals).toEqual(["journal-discord_residency-test-epoch-1.md"]);
    const onDisk = (await allFileText(env.chainDir)) + (await allFileText(env.journalDir));
    expect(onDisk).not.toContain(RAW_LINE);
    expect(onDisk).not.toContain(GAP_LINE);
  });

  it("commit sweep (enabled) promotes the departed epoch's candidates before re-arrival", async () => {
    const timer = new FakeTimer();
    const brain = lifecycleBrain();
    handle = await startResidencyDaemon(
      env.config({ commitIntervalMs: 10_000, quarantineWindowMs: 1 }),
      {
        brain,
        timer,
        logger: pino({ level: "silent" }),
        skipSignals: true,
        // Real time stays real (candidates must age 1 ms); polls just don't wait 10 s.
        sleep: (_ms, signal) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            });
          })
      }
    );
    const daemon = handle;
    await waitFor(() => env.wsServer.getActiveClients().size === 1, "socket");
    env.wsServer.broadcastInbound({ text: RAW_LINE, author_id: "u1" }, "in-1");
    await waitFor(() => brain.calls.length === 1, "reply");

    const outcome = await daemon.requestCycle("operator");
    expect(outcome).toMatchObject({
      kind: "cycled",
      fromEpoch: 1,
      toEpoch: 2,
      candidateCount: SHARDS.length,
      committedCount: SHARDS.length
    });
    await daemon.shutdown();
    handle = null;

    const records = await readChain(env.chainDir);
    const shards = records.filter(
      (record) => record.type === "memory" && record.body.kind === "shard"
    );
    expect(shards).toHaveLength(SHARDS.length);
    expect(shards.filter((record) => "journal_cid" in record.body)).toHaveLength(1);
    // Commits land in the travel gap: after travel:1, before arrival:2.
    const order = records.map((record) =>
      record.type === "attestation"
        ? record.body.kind
        : record.type === "memory"
          ? record.body.kind
          : record.type
    );
    expect(order.lastIndexOf("shard")).toBeLessThan(order.lastIndexOf("arrival"));
    expect(order.indexOf("shard")).toBeGreaterThan(order.indexOf("travel"));
  });

  it("past-epoch Door: re-arrives at once, then the live sweep commits epoch 1 after a 24 h window", async () => {
    await env.wsServer.stop();
    await env.httpServer.stop();
    const clock = new OffsetClock();
    env = await createEnv({ pastEpochs: true, clock });
    const timer = new FakeTimer();
    const brain = lifecycleBrain();
    // Default 24 h window: refused before cosign.past_epochs, accepted now.
    handle = await startResidencyDaemon(env.config({ commitIntervalMs: 30_000 }), {
      brain,
      timer,
      clock,
      logger: pino({ level: "silent" }),
      skipSignals: true
    });
    const daemon = handle;
    await waitFor(() => env.wsServer.getActiveClients().size === 1, "socket");
    env.wsServer.broadcastInbound({ text: RAW_LINE, author_id: "u1" }, "in-1");
    await waitFor(() => brain.calls.length === 1, "reply");

    // The cycle no longer waits out the window in the travel gap.
    const outcome = await daemon.requestCycle("operator");
    expect(outcome).toMatchObject({
      kind: "cycled",
      fromEpoch: 1,
      toEpoch: 2,
      candidateCount: SHARDS.length,
      committedCount: 0
    });
    await waitFor(() => env.wsServer.getActiveClients().size === 1, "second socket");
    expect(env.door.getActiveEpoch()).toBe(2);

    const shardCount = async (): Promise<number> =>
      (await readFile(join(env.chainDir, "chain.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.includes('"kind":"shard"')).length;

    // While ripening, a sweep tick commits nothing.
    timer.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(await shardCount()).toBe(0);

    // A day later (Door and daemon share the clock), the live sweep commits epoch 1's
    // candidates while epoch 2 is live — the Door still holds epoch 1's review.
    clock.offsetMs = 24 * 60 * 60 * 1000 + 60_000;
    timer.tick();
    await waitFor(async () => (await shardCount()) === SHARDS.length, "live commits");
    expect(daemon.currentEpoch()).toBe(2);
    // Still live: inbound on epoch 2 is answered.
    env.wsServer.broadcastInbound({ text: "still here?", author_id: "u2" }, "in-2");
    await waitFor(() => brain.calls.length >= 4, "reply in epoch 2");
    await daemon.shutdown();
    handle = null;

    const records = await readChain(env.chainDir);
    const shards = records.filter(
      (record) => record.type === "memory" && record.body.kind === "shard"
    );
    expect(shards).toHaveLength(SHARDS.length);
    expect(shards.every((record) => record.residency === `door:${DOOR_ID}/epoch:1`)).toBe(true);
    expect(shards.filter((record) => "journal_cid" in record.body)).toHaveLength(1);
    const order = records.map((record) =>
      record.type === "attestation"
        ? `${String(record.body.kind)}:${String(record.body.epoch ?? record.body.from_epoch)}`
        : record.type === "memory"
          ? String(record.body.kind)
          : record.type
    );
    // Commits land during residency 2, after its arrival.
    expect(order.indexOf("shard")).toBeGreaterThan(order.indexOf("arrival:2"));
  });

  it("legacy Door + commit sweep + 24 h window: boot refuses before any append", async () => {
    await expect(
      startResidencyDaemon(env.config({ commitIntervalMs: 30_000 }), {
        brain: lifecycleBrain(),
        timer: new FakeTimer(),
        logger: pino({ level: "silent" }),
        skipSignals: true
      })
    ).rejects.toMatchObject({ reason: "invalid_config", envVar: "NPC_QUARANTINE_WINDOW_MS" });
    const records = await readChain(env.chainDir);
    expect(records.map((record) => record.type)).toEqual(["genesis"]);
  });

  it("SIGUSR2 triggers a cycle when the operator trigger is enabled; listeners are removed on shutdown", async () => {
    const before = process.listenerCount("SIGUSR2");
    const beforeTerm = process.listenerCount("SIGTERM");
    const timer = new FakeTimer();
    const brain = lifecycleBrain();
    handle = await startResidencyDaemon(env.config({ operatorTrigger: true }), {
      brain,
      timer,
      logger: pino({ level: "silent" }),
      skipSignals: false
    });
    const daemon = handle;
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
    await waitFor(() => env.wsServer.getActiveClients().size === 1, "socket");
    env.wsServer.broadcastInbound({ text: RAW_LINE, author_id: "u1" }, "in-1");
    await waitFor(() => brain.calls.length === 1, "reply");

    process.kill(process.pid, "SIGUSR2");
    await waitFor(() => daemon.currentEpoch() === 2, "re-arrival after SIGUSR2");

    await daemon.shutdown();
    handle = null;
    expect(process.listenerCount("SIGUSR2")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("with every trigger off (defaults) nothing departs on its own", async () => {
    const timer = new FakeTimer();
    const before = process.listenerCount("SIGUSR2");
    handle = await startResidencyDaemon(env.config(), {
      brain: lifecycleBrain(),
      timer,
      logger: pino({ level: "silent" }),
      skipSignals: false
    });
    // SIGUSR2 is still handled (ignored) so a stray signal cannot kill the daemon.
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
    // Enough conversation that any enabled trigger would cycle.
    await waitFor(() => env.wsServer.getActiveClients().size === 1, "socket");
    for (let i = 0; i < 12; i += 1) {
      env.wsServer.broadcastInbound(
        { text: `line ${String(i)}`, author_id: "u1" },
        `in-${String(i)}`
      );
    }
    process.kill(process.pid, "SIGUSR2");
    await writeDepartRequest(env.controlDir, new Date().toISOString());
    for (let i = 0; i < 5; i += 1) timer.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(handle.currentEpoch()).toBe(1);
    // The request is left for no one (Ghost: tmpfs, cleared on restart).
    await readFile(join(env.controlDir, "depart.request"), "utf8");
    await handle.shutdown();
    handle = null;
    expect(
      attestations(await readChain(env.chainDir)).filter((a) => a.startsWith("departure"))
    ).toEqual([]);
  });
});
