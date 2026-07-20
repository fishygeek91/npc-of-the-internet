import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  createRecord,
  signCore,
  generateKeypair,
  encodePublicKey,
  FileSoulStore,
  verifyRecords,
  verifyChain,
  type Ed25519Keypair,
  type OspRecord
} from "../src/index.js";

const RESIDENCY = "door:discord:g/epoch:1";
const WRONG_PREV_CID = "bagu4eraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Create a unique temporary directory for an isolated store. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "osp-verify-chain-"));
}

/** Build a signed genesis record. */
async function createGenesisRecord(soul: Ed25519Keypair) {
  return createRecord({
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed arrival attestation with door cosignature. */
async function createArrivalRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair,
  seq: number,
  prev: string
) {
  const fields = {
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: "pop/0.1" as const,
      door_id: "discord:g",
      epoch: 1,
      session_pubkey: encodePublicKey(session.publicKey),
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY
  };
  const cosig = signCore(fields, door.privateKey);
  return createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed memory shard with door cosignature. */
async function createShardRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string
) {
  const fields = {
    seq,
    prev,
    type: "memory" as const,
    body: {
      kind: "shard" as const,
      text,
      distilled_at: "2026-01-02T01:00:00.000Z"
    },
    residency: RESIDENCY
  };
  const cosig = signCore(fields, door.privateKey);
  return createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed drift record citing shard evidence. */
async function createDriftRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  evidence: string[]
) {
  return createRecord({
    seq,
    prev,
    type: "drift",
    body: {
      summary: "I feel more patient after the long stay.",
      evidence,
      effective_at: "2026-01-03T00:00:00.000Z"
    },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build genesis → arrival → shard → drift chain. */
async function createValidMiniChain(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair
) {
  const genesis = await createGenesisRecord(soul);
  const arrival = await createArrivalRecord(soul, door, session, 1, genesis.cid);
  const shard = await createShardRecord(soul, door, 2, arrival.cid, "A committed shard memory.");
  const drift = await createDriftRecord(soul, 3, shard.cid, [shard.cid]);
  return { genesis, arrival, shard, drift };
}

function expectInvalid(result: Awaited<ReturnType<typeof verifyRecords>>, rule: string): void {
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  expect(result.failures.some((failure) => failure.rule === rule)).toBe(true);
}

describe("verifyRecords", () => {
  let soul: Ed25519Keypair;
  let door: Ed25519Keypair;
  let session: Ed25519Keypair;

  beforeEach(() => {
    soul = generateKeypair();
    door = generateKeypair();
    session = generateKeypair();
  });

  it("accepts an empty chain with null head", async () => {
    const result = await verifyRecords([]);
    expect(result).toEqual({ valid: true, head: null });
  });

  it("accepts a short valid chain (genesis → arrival → shard → drift)", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const records = [
      chain.genesis.record,
      chain.arrival.record,
      chain.shard.record,
      chain.drift.record
    ];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expect(result.valid).toBe(true);
    if (!result.valid) {
      return;
    }
    expect(result.head).toEqual({ cid: chain.drift.cid, seq: 3 });
  });

  it("rejects bad_soul_sig", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const tampered: OspRecord = {
      ...chain.shard.record,
      sig:
        chain.shard.record.sig.slice(0, 4) +
        (chain.shard.record.sig[4] === "A" ? "B" : "A") +
        chain.shard.record.sig.slice(5)
    };
    const records = [chain.genesis.record, chain.arrival.record, tampered, chain.drift.record];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expectInvalid(result, "bad_soul_sig");
  });

  it("rejects broken_prev_link", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const broken = await createShardRecord(soul, door, 2, WRONG_PREV_CID, "Broken prev.");
    const records = [chain.genesis.record, chain.arrival.record, broken.record, chain.drift.record];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expectInvalid(result, "broken_prev_link");
  });

  it("rejects seq_gap", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const gapShard = await createShardRecord(soul, door, 4, chain.arrival.cid, "Sequence gap.");
    const records = [chain.genesis.record, chain.arrival.record, gapShard.record];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expectInvalid(result, "seq_gap");
  });

  it("rejects schema_violation", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const invalid = {
      ...chain.arrival.record,
      spec: "osp/0.2"
    };
    const records = [chain.genesis.record, invalid, chain.shard.record, chain.drift.record];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expectInvalid(result, "schema_violation");
  });

  it("rejects missing_cosigner when the door key is unknown", async () => {
    const unknownDoor = generateKeypair();
    const chain = await createValidMiniChain(soul, unknownDoor, session);
    const otherDoor = generateKeypair();

    const records = [
      chain.genesis.record,
      chain.arrival.record,
      chain.shard.record,
      chain.drift.record
    ];

    const result = await verifyRecords(records, { doorPublicKeys: [otherDoor.publicKey] });
    expectInvalid(result, "missing_cosigner");
  });

  it("rejects forked_head when two records share the same seq", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const forkedArrival = await createArrivalRecord(soul, door, session, 1, chain.genesis.cid);
    const records = [
      chain.genesis.record,
      chain.arrival.record,
      forkedArrival.record,
      chain.shard.record,
      chain.drift.record
    ];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expectInvalid(result, "forked_head");
  });

  it("rejects bad_drift_evidence", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const drift = await createDriftRecord(soul, 3, chain.shard.cid, [WRONG_PREV_CID]);
    const records = [chain.genesis.record, chain.arrival.record, chain.shard.record, drift.record];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expectInvalid(result, "bad_drift_evidence");
  });

  it("rejects bad_genesis when the first record is not genesis", async () => {
    const chain = await createValidMiniChain(soul, door, session);
    const records = [chain.arrival.record, chain.shard.record, chain.drift.record];

    const result = await verifyRecords(records, { doorPublicKeys: [door.publicKey] });
    expectInvalid(result, "bad_genesis");
  });
});

describe("verifyChain", () => {
  let dir: string;
  let soul: Ed25519Keypair;
  let door: Ed25519Keypair;
  let session: Ed25519Keypair;

  beforeEach(async () => {
    dir = await makeTempDir();
    soul = generateKeypair();
    door = generateKeypair();
    session = generateKeypair();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("verifies a valid mini-chain stored in FileSoulStore", async () => {
    const store = await FileSoulStore.open(dir, { doorPublicKeys: [door.publicKey] });
    try {
      const chain = await createValidMiniChain(soul, door, session);
      await store.append(chain.genesis.record);
      await store.append(chain.arrival.record);
      await store.append(chain.shard.record);
      await store.append(chain.drift.record);

      const result = await verifyChain(store, { doorPublicKeys: [door.publicKey] });
      expect(result.valid).toBe(true);
      if (!result.valid) {
        return;
      }
      expect(result.head).toEqual({ cid: chain.drift.cid, seq: 3 });
    } finally {
      await store.close();
    }
  });
});
