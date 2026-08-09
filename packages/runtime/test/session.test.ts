import {
  verifyChain,
  type AppendResult,
  type HeadInfo,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { BrainError } from "../src/brain/errors.js";
import { FakeBrain } from "../src/brain/fake-brain.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { Session } from "../src/session/session.js";
import { SessionError } from "../src/session/errors.js";
import type { InboundFrame } from "../src/session/types.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { createGenesisRecord, DOOR_ID, doorPublicKeyFor } from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const CLOCK_START = "2026-07-20T00:00:00.000Z";
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Delegates to {@link MemorySoulStore} but can block {@link append} until resumed.
 */
class PausingStore implements SoulStore {
  private readonly inner = new MemorySoulStore();
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  pauseNext(): void {
    if (this.gate !== null) {
      return;
    }
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  resume(): void {
    if (this.releaseGate !== null) {
      this.releaseGate();
      this.releaseGate = null;
      this.gate = null;
    }
  }

  async append(record: OspRecord): Promise<AppendResult> {
    if (this.gate !== null) {
      await this.gate;
    }
    return this.inner.append(record);
  }

  async head(): Promise<HeadInfo | null> {
    return this.inner.head();
  }

  async get(cid: string): Promise<OspRecord> {
    return this.inner.get(cid);
  }

  async *iterate(): AsyncIterable<OspRecord> {
    yield* this.inner.iterate();
  }
}

/**
 * Fails on the Nth {@link append} call (1-based) to simulate crash windows / disk errors.
 */
class FailNthAppendStore implements SoulStore {
  private readonly inner = new MemorySoulStore();
  private appendCount = 0;

  constructor(private readonly failOnAppendNumber: number) {}

  async append(record: OspRecord): Promise<AppendResult> {
    this.appendCount += 1;
    if (this.appendCount === this.failOnAppendNumber) {
      throw new Error("simulated append failure");
    }
    return this.inner.append(record);
  }

  async head(): Promise<HeadInfo | null> {
    return this.inner.head();
  }

  async get(cid: string): Promise<OspRecord> {
    return this.inner.get(cid);
  }

  async *iterate(): AsyncIterable<OspRecord> {
    yield* this.inner.iterate();
  }
}

function createInboundFrame(text: string, msgId: string): InboundFrame {
  return {
    type: "inbound",
    door_id: DOOR_ID,
    epoch: 1,
    msg_id: msgId,
    issued_at: CLOCK_START,
    body: {
      text,
      author_id: "user-1"
    }
  };
}

async function buildGenesisStore(): Promise<MemorySoulStore> {
  const store = new MemorySoulStore();
  const genesis = await createGenesisRecord(SOUL);
  await store.append(genesis.record);
  return store;
}

function createSessionHarness(store: SoulStore) {
  const clock = new FakeClock(CLOCK_START);
  const timer = new FakeTimer();
  const keyring = new SingleKeyKeyring(SOUL.privateKey);
  const door = new DoorStub({
    doorId: DOOR_ID,
    doorKeypair: DOOR,
    soulPublicKey: SOUL.publicKey,
    clock
  });
  const brain = new FakeBrain(["Hello back.", "Still here."]);

  return {
    clock,
    timer,
    keyring,
    door,
    brain,
    async start(): Promise<Session> {
      return Session.start({
        store,
        brain,
        door,
        keyring,
        doorId: DOOR_ID,
        timer,
        clock,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
      });
    }
  };
}

describe("Session", () => {
  it("start on genesis-only store appends arrival and verifyChain passes", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store);

    const session = await harness.start();

    expect(session.epoch).toBe(1);

    const records: OspRecord[] = [];
    for await (const record of store.iterate()) {
      records.push(record);
    }
    expect(records).toHaveLength(2);
    expect(records[1]?.type).toBe("attestation");
    if (records[1]?.type === "attestation") {
      expect(records[1].body.kind).toBe("arrival");
      expect(records[1].body.epoch).toBe(1);
    }

    const result = await verifyChain(store, {
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });
    expect(result.valid).toBe(true);

    session.stop();
  });

  it("handleInbound with FakeBrain returns outbound verified by DoorStub", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store);
    const session = await harness.start();

    const inbound = createInboundFrame("Who are you?", "in-1");
    const result = await session.handleInbound(inbound);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(harness.door.verifyOutbound(result.outbound)).toBe(true);
      expect(result.outbound.body.text).toBe("Hello back.");
      expect(result.outbound.body.reply_to).toBeUndefined();
    }

    session.stop();
  });

  it("BrainError does not kill the session; a second message still works", async () => {
    const store = await buildGenesisStore();
    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    let callCount = 0;
    const brain = new FakeBrain(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new BrainError("simulated brain failure");
      }
      return "Recovery reply.";
    });

    const session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });

    const failed = await session.handleInbound({
      ...createInboundFrame("fail please", "in-fail"),
      body: { text: "fail please", author_id: "user-1" }
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toBeInstanceOf(BrainError);
    }

    const recovered = await session.handleInbound(createInboundFrame("try again", "in-2"));
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(door.verifyOutbound(recovered.outbound)).toBe(true);
      expect(recovered.outbound.body.text).toBe("Recovery reply.");
    }

    session.stop();
  });

  it("serializes concurrent appends so arrival and heartbeat both land with valid chain", async () => {
    const store = new PausingStore();
    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const brain = new FakeBrain(["ok"]);

    const session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });

    store.pauseNext();
    timer.tick();
    timer.tick();

    store.resume();
    await session.drainAppends();

    const records: OspRecord[] = [];
    for await (const record of store.iterate()) {
      records.push(record);
    }
    expect(records.length).toBeGreaterThanOrEqual(3);

    const heartbeats = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "heartbeat"
    );
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    const result = await verifyChain(store, {
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });
    expect(result.valid).toBe(true);

    session.stop();
  });

  it("heartbeat tick after start produces heartbeat attestation with cosigner", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store);
    const session = await harness.start();

    harness.timer.tick();
    await session.drainAppends();

    const records: OspRecord[] = [];
    for await (const record of store.iterate()) {
      records.push(record);
    }

    const heartbeat = records.find(
      (record) => record.type === "attestation" && record.body.kind === "heartbeat"
    );
    expect(heartbeat).toBeDefined();
    if (heartbeat !== undefined) {
      expect(heartbeat.cosigners.length).toBeGreaterThan(0);
      if (heartbeat.type === "attestation" && heartbeat.body.kind === "heartbeat") {
        expect(heartbeat.body.epoch).toBe(session.epoch);
      }
    }

    expect(session.lastHeartbeatError).toBeNull();

    session.stop();
  });

  it("stop rejects new inbound frames", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store);
    const session = await harness.start();

    session.stop();

    await expect(session.handleInbound(createInboundFrame("too late", "in-late"))).rejects.toThrow(
      SessionError
    );
  });

  it("increments heartbeat seq after Door ack even when attest fails", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store);
    const session = await harness.start();

    const originalAttest = harness.door.attest.bind(harness.door);
    let heartbeatAttestCalls = 0;
    harness.door.attest = async (request) => {
      if (request.kind === "heartbeat") {
        heartbeatAttestCalls += 1;
        if (heartbeatAttestCalls === 1) {
          throw new Error("simulated attest failure after heartbeat ack");
        }
      }
      return originalAttest(request);
    };

    harness.timer.tick();
    await session.drainAppends();
    expect(session.lastHeartbeatError).not.toBeNull();

    harness.timer.tick();
    await session.drainAppends();
    expect(session.lastHeartbeatError).toBeNull();

    const records: OspRecord[] = [];
    for await (const record of store.iterate()) {
      records.push(record);
    }
    const heartbeats = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "heartbeat"
    );
    expect(heartbeats).toHaveLength(1);

    session.stop();
  });

  it("stop fences queued heartbeat so no heartbeat attestation lands after stop", async () => {
    const store = new PausingStore();
    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const harness = createSessionHarness(store);
    const session = await harness.start();

    store.pauseNext();
    harness.timer.tick();
    session.stop();
    store.resume();
    await session.drainAppends();

    const records: OspRecord[] = [];
    for await (const record of store.iterate()) {
      records.push(record);
    }
    const heartbeats = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "heartbeat"
    );
    expect(heartbeats).toHaveLength(0);

    const arrivals = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "arrival"
    );
    expect(arrivals).toHaveLength(1);
  });

  it("serializes concurrent handleInbound so history stays ordered and Brain calls do not overlap", async () => {
    const store = await buildGenesisStore();
    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let callIndex = 0;
    const brain = new FakeBrain(async (messages) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      callIndex += 1;
      const thisCall = callIndex;
      if (thisCall === 1) {
        await firstGate;
      }
      inFlight -= 1;
      const userMessages = messages.filter((message) => message.role === "user");
      return `reply-${String(userMessages.length)}`;
    });

    const session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });

    const firstPromise = session.handleInbound(createInboundFrame("first", "in-1"));
    const secondPromise = session.handleInbound(createInboundFrame("second", "in-2"));

    await Promise.resolve();
    expect(brain.calls).toHaveLength(1);

    if (releaseFirst === undefined) {
      throw new Error("expected first Brain gate");
    }
    releaseFirst();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(brain.calls).toHaveLength(2);

    const secondUserContents = brain.calls[1]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(secondUserContents).toEqual(["first", "second"]);

    if (first.ok && second.ok) {
      expect(first.outbound.body.text).toBe("reply-1");
      expect(second.outbound.body.text).toBe("reply-2");
      expect(first.outbound.msg_id).toBe("out-1");
      expect(second.outbound.msg_id).toBe("out-2");
    }

    session.stop();
  });

  it("onHeartbeatError reports door stage when Door heartbeat fails", async () => {
    const store = await buildGenesisStore();
    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const brain = new FakeBrain(["ok"]);
    const stages: Array<"door" | "append"> = [];

    door.heartbeat = async () => {
      throw new Error("simulated door heartbeat failure");
    };

    const session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey),
      onHeartbeatError: (_error, stage) => {
        stages.push(stage);
      }
    });

    timer.tick();
    await session.drainAppends();

    expect(stages).toEqual(["door"]);
    expect(session.lastHeartbeatError).not.toBeNull();

    session.stop();
  });

  it("onHeartbeatError reports append stage when store.append fails after attest", async () => {
    // Append 1 = genesis, 2 = arrival, 3 = heartbeat body — fail the heartbeat append.
    const store = new FailNthAppendStore(3);
    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const brain = new FakeBrain(["ok"]);
    const stages: Array<"door" | "append"> = [];

    const session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey),
      onHeartbeatError: (_error, stage) => {
        stages.push(stage);
      }
    });

    // Manual genesis = append #1, arrival = #2; heartbeat body fails on append #3.
    timer.tick();
    await session.drainAppends();

    expect(stages).toEqual(["append"]);
    expect(session.lastHeartbeatError).not.toBeNull();

    session.stop();
  });

  it("Session.start uses max(chainDerived, activeEpoch+1) after mid-arrival crash window", async () => {
    // Append 1 = genesis, 2 = arrival — fail after Door attest accepts epoch 1.
    const failingStore = new FailNthAppendStore(2);
    const genesis = await createGenesisRecord(SOUL);
    await failingStore.append(genesis.record);

    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const brain = new FakeBrain(["ok"]);

    await expect(
      Session.start({
        store: failingStore,
        brain,
        door,
        keyring,
        doorId: DOOR_ID,
        timer,
        clock,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
      })
    ).rejects.toThrow("simulated append failure");

    // Door accepted arrival epoch 1; chain still genesis-only.
    const recoveryStore = await buildGenesisStore();
    const recoverySession = await Session.start({
      store: recoveryStore,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer: new FakeTimer(),
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey),
      activeEpoch: 1
    });

    expect(recoverySession.epoch).toBe(2);

    recoverySession.stop();
  });
});
