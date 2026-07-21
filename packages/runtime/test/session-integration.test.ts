import { encodePublicKey, verifyChain, type OspRecord } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { Session } from "../src/session/session.js";
import { SessionError } from "../src/session/errors.js";
import type { InboundFrame, OutboundFrame } from "../src/session/types.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { createGenesisRecord, DOOR_ID } from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const CLOCK_START = "2026-07-20T00:00:00.000Z";
const HEARTBEAT_INTERVAL_MS = 60_000;
const MESSAGE_COUNT = 20;
const FIRST_BATCH = 10;

/** Build an inbound frame bound to the session's door and epoch. */
function createInboundFrame(session: Session, text: string, msgId: string): InboundFrame {
  return {
    type: "inbound",
    door_id: DOOR_ID,
    epoch: session.epoch,
    msg_id: msgId,
    issued_at: CLOCK_START,
    body: {
      text,
      author_id: "user-integration"
    }
  };
}

/** Collect all records from the store. */
async function collectRecords(store: MemorySoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

describe("Session integration (20-message residency)", () => {
  it("produces a verifying chain with arrival, heartbeats, and signed outbounds", async () => {
    const store = new MemorySoulStore();
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

    const scriptedReplies = Array.from(
      { length: MESSAGE_COUNT },
      (_, index) => `Reply ${String(index + 1)}`
    );
    const brain = new FakeBrain(scriptedReplies);
    const outbounds: OutboundFrame[] = [];

    const session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: [DOOR.publicKey]
    });

    const expectedSessionPubkey = encodePublicKey(session.sessionPublicKey);
    expect(session.epoch).toBe(1);

    for (let index = 0; index < FIRST_BATCH; index += 1) {
      const inbound = createInboundFrame(
        session,
        `Message ${String(index + 1)}`,
        `in-${String(index + 1)}`
      );
      const result = await session.handleInbound(inbound);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(door.verifyOutbound(result.outbound)).toBe(true);
        expect(result.outbound.body.text).toBe(scriptedReplies[index]);
        outbounds.push(result.outbound);
      }
    }

    timer.tick();
    timer.tick();
    await session.drainAppends();

    let records = await collectRecords(store);
    const heartbeatsAfterFirstBatch = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "heartbeat"
    );
    expect(heartbeatsAfterFirstBatch.length).toBeGreaterThanOrEqual(2);

    for (let index = FIRST_BATCH; index < MESSAGE_COUNT; index += 1) {
      const inbound = createInboundFrame(
        session,
        `Message ${String(index + 1)}`,
        `in-${String(index + 1)}`
      );
      const result = await session.handleInbound(inbound);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(door.verifyOutbound(result.outbound)).toBe(true);
        expect(result.outbound.body.text).toBe(scriptedReplies[index]);
        outbounds.push(result.outbound);
      }
    }

    timer.tick();
    await session.drainAppends();

    records = await collectRecords(store);

    const arrivals = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "arrival"
    );
    expect(arrivals).toHaveLength(1);
    const arrival = arrivals[0];
    expect(arrival).toBeDefined();
    if (
      arrival !== undefined &&
      arrival.type === "attestation" &&
      arrival.body.kind === "arrival"
    ) {
      expect(arrival.body.epoch).toBe(1);
      expect(arrival.body.session_pubkey).toBe(expectedSessionPubkey);
      expect(arrival.cosigners.length).toBeGreaterThan(0);
    }

    const heartbeats = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "heartbeat"
    );
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    for (const heartbeat of heartbeats) {
      if (heartbeat.type === "attestation" && heartbeat.body.kind === "heartbeat") {
        expect(heartbeat.body.session_pubkey).toBe(expectedSessionPubkey);
        expect(heartbeat.cosigners.length).toBeGreaterThan(0);
      }
    }

    const chainResult = await verifyChain(store, { doorPublicKeys: [DOOR.publicKey] });
    expect(chainResult.valid).toBe(true);

    expect(outbounds).toHaveLength(MESSAGE_COUNT);
    for (const outbound of outbounds) {
      expect(door.verifyOutbound(outbound)).toBe(true);
    }

    const goodOutbound = outbounds[0];
    expect(goodOutbound).toBeDefined();
    if (goodOutbound !== undefined) {
      const tamperedText: OutboundFrame = {
        ...goodOutbound,
        body: { ...goodOutbound.body, text: "Tampered text." }
      };
      expect(door.verifyOutbound(tamperedText)).toBe(false);
    }

    await expect(
      session.handleInbound({
        ...createInboundFrame(session, "wrong epoch", "in-bad-epoch"),
        epoch: session.epoch + 1
      })
    ).rejects.toThrow(SessionError);

    session.stop();
  });
});
