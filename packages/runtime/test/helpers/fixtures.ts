import {
  createRecord,
  encodePublicKey,
  signCore,
  type CreateRecordResult,
  type Ed25519Keypair,
  type OspRecord
} from "@npc/osp-core";

import { DOOR, OTHER_DOOR, SESSION, SOUL } from "./fixed-keys.js";
import { MemorySoulStore } from "./memory-soul-store.js";

export const RESIDENCY = "door:discord:g/epoch:1";
export const DOOR_ID = "discord:g";

export const CHARTER = "# Wanderer\n\nI travel the doors.";
export const SHARD_A_TEXT = "I remember the quiet guild hall.";
export const SHARD_B_TEXT = "I learned to leave without apology.";
export const CANDIDATE_TEXT = "QUARANTINE_CANDIDATE_SECRET";
export const REJECTED_CATEGORY = "QUARANTINE_REJECTED_CATEGORY";
export const DRIFT_SUMMARY = "I feel more patient after the long stay.";
export const JOURNAL_TEXT = "host-facing journal must not appear";

export type FixtureResult = {
  store: MemorySoulStore;
  doorPublicKeys: readonly Uint8Array[];
};

export type FixtureBResult = FixtureResult & {
  shardRecords: readonly [OspRecord, OspRecord];
};

/** Build a signed genesis record. */
export async function createGenesisRecord(soul: Ed25519Keypair): Promise<CreateRecordResult> {
  return createRecord({
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: CHARTER,
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed arrival attestation with door cosignature. */
export async function createArrivalRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair,
  seq: number,
  prev: string
): Promise<CreateRecordResult> {
  const fields = {
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: "pop/0.1" as const,
      door_id: DOOR_ID,
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
export async function createShardRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string,
  opts?: { journal?: string; candidateCid?: string }
): Promise<CreateRecordResult> {
  const body: {
    kind: "shard";
    text: string;
    distilled_at: string;
    journal?: string;
    candidate_cid?: string;
  } = {
    kind: "shard",
    text,
    distilled_at: "2026-01-02T01:00:00.000Z"
  };
  if (opts?.journal !== undefined) {
    body.journal = opts.journal;
  }
  if (opts?.candidateCid !== undefined) {
    body.candidate_cid = opts.candidateCid;
  }

  const fields = {
    seq,
    prev,
    type: "memory" as const,
    body,
    residency: RESIDENCY
  };
  const cosig = signCore(fields, door.privateKey);
  return createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed quarantine candidate memory (no door cosignature). */
export async function createCandidateRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string
): Promise<CreateRecordResult> {
  return createRecord({
    seq,
    prev,
    type: "memory",
    body: {
      kind: "candidate",
      text,
      proposed_at: "2026-01-02T01:30:00.000Z"
    },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed rejected candidate memory (no door cosignature). */
export async function createRejectedRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  category: string,
  opts?: { candidateCid?: string }
): Promise<CreateRecordResult> {
  const body: {
    kind: "rejected";
    category: string;
    candidate_cid?: string;
    rejected_at: string;
  } = {
    kind: "rejected",
    category,
    rejected_at: "2026-01-02T02:00:00.000Z"
  };
  if (opts?.candidateCid !== undefined) {
    body.candidate_cid = opts.candidateCid;
  }

  return createRecord({
    seq,
    prev,
    type: "memory",
    body,
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed drift record citing shard evidence. */
export async function createDriftRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  summary: string,
  evidence: string[]
): Promise<CreateRecordResult> {
  return createRecord({
    seq,
    prev,
    type: "drift",
    body: {
      summary,
      evidence,
      effective_at: "2026-01-03T00:00:00.000Z"
    },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Fixture A: genesis only. */
export async function buildFixtureA(): Promise<FixtureResult> {
  const store = new MemorySoulStore();
  const genesis = await createGenesisRecord(SOUL);
  await store.append(genesis.record);

  return {
    store,
    doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
  };
}

/**
 * Fixture B: canonical residency chain for compose and T2.4 reuse.
 * seq 0 genesis → 1 arrival → 2 shard A → 3 shard B → 4 candidate → 5 rejected → 6 drift.
 */
export async function buildFixtureB(): Promise<FixtureBResult> {
  const store = new MemorySoulStore();

  const genesis = await createGenesisRecord(SOUL);
  await store.append(genesis.record);

  const arrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, genesis.cid);
  await store.append(arrival.record);

  const shardA = await createShardRecord(SOUL, DOOR, 2, arrival.cid, SHARD_A_TEXT);
  await store.append(shardA.record);

  const shardB = await createShardRecord(SOUL, DOOR, 3, shardA.cid, SHARD_B_TEXT, {
    journal: JOURNAL_TEXT
  });
  await store.append(shardB.record);

  const candidate = await createCandidateRecord(SOUL, 4, shardB.cid, CANDIDATE_TEXT);
  await store.append(candidate.record);

  const rejected = await createRejectedRecord(SOUL, 5, candidate.cid, REJECTED_CATEGORY);
  await store.append(rejected.record);

  const drift = await createDriftRecord(SOUL, 6, rejected.cid, DRIFT_SUMMARY, [
    shardA.cid,
    shardB.cid
  ]);
  await store.append(drift.record);

  return {
    store,
    doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey],
    shardRecords: [shardA.record, shardB.record]
  };
}
