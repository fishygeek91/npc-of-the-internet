import {
  OSP_SPEC_V02,
  contentAddressSideBlob,
  createRecord,
  decodeJournalBlob,
  decodeShardTextBlob,
  encodeJournalBlob,
  encodePublicKey,
  encodeShardTextBlob,
  signCore,
  type CreateRecordResult,
  type Ed25519Keypair,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";

import { DOOR, OTHER_DOOR, SESSION, SOUL } from "./fixed-keys.js";
import { MemorySoulStore } from "./memory-soul-store.js";

export const RESIDENCY = "door:discord:g/epoch:1";
export const DOOR_ID = "discord:g";
export const OTHER_DOOR_ID = "irc:libera-wanderer";

export const CHARTER = "# Wanderer\n\nI travel the doors.";
export const SHARD_A_TEXT = "I remember the quiet guild hall.";
export const SHARD_B_TEXT = "I learned to leave without apology.";
export const CANDIDATE_TEXT = "QUARANTINE_CANDIDATE_SECRET";
export const REJECTED_CATEGORY = "QUARANTINE_REJECTED_CATEGORY";
export const DRIFT_SUMMARY = "I feel more patient after the long stay.";
export const JOURNAL_TEXT = "host-facing journal must not appear";

export type FixtureResult = {
  store: MemorySoulStore;
  doorPublicKeys: Readonly<Record<string, Uint8Array>>;
};

export type FixtureBResult = FixtureResult & {
  shardRecords: readonly [OspRecord, OspRecord];
};

/** Door public keys for fixture chains (both residency doors). */
export function fixtureDoorPublicKeys(): Readonly<Record<string, Uint8Array>> {
  return {
    [DOOR_ID]: DOOR.publicKey,
    [OTHER_DOOR_ID]: OTHER_DOOR.publicKey
  };
}

/** Single-door public key map for tests that cosign under one residency. */
export function doorPublicKeyFor(
  doorId: string,
  publicKey: Uint8Array
): Readonly<Record<string, Uint8Array>> {
  return { [doorId]: publicKey };
}

/** Store shard text as a side blob; return CID+hash. */
async function putShardText(
  store: SoulStore,
  text: string
): Promise<{ text_cid: string; text_hash: string }> {
  const bytes = encodeShardTextBlob(text);
  const addr = await contentAddressSideBlob(bytes);
  await store.putSideBlob(bytes);
  return { text_cid: addr.cid, text_hash: addr.hash };
}

/** Store journal markdown as a side blob; return CID+hash. */
async function putJournal(
  store: SoulStore,
  markdown: string
): Promise<{ journal_cid: string; journal_hash: string }> {
  const bytes = encodeJournalBlob(markdown);
  const addr = await contentAddressSideBlob(bytes);
  await store.putSideBlob(bytes);
  return { journal_cid: addr.cid, journal_hash: addr.hash };
}

/**
 * Resolve osp/0.2 shard/candidate prose from its side blob.
 *
 * @param store - SoulStore holding the side blob bytes
 * @param record - memory record with `kind` shard or candidate
 */
export async function resolveMemoryText(store: SoulStore, record: OspRecord): Promise<string> {
  if (record.type !== "memory") {
    throw new Error(`expected memory record, got ${record.type}`);
  }
  if (record.body.kind !== "shard" && record.body.kind !== "candidate") {
    throw new Error(`expected shard or candidate, got ${record.body.kind}`);
  }
  if (!("text_cid" in record.body) || record.body.text_cid === undefined) {
    throw new Error("memory record missing text_cid");
  }
  const bytes = await store.getSideBlob(record.body.text_cid);
  return decodeShardTextBlob(bytes);
}

/**
 * Resolve osp/0.2 journal markdown from its side blob when present.
 *
 * @param store - SoulStore holding the side blob bytes
 * @param record - memory shard that may carry journal_cid
 */
export async function resolveJournalMarkdown(
  store: SoulStore,
  record: OspRecord
): Promise<string | undefined> {
  if (record.type !== "memory" || record.body.kind !== "shard") {
    return undefined;
  }
  if (!("journal_cid" in record.body) || record.body.journal_cid === undefined) {
    return undefined;
  }
  const bytes = await store.getSideBlob(record.body.journal_cid);
  return decodeJournalBlob(bytes);
}

/** Build a signed genesis record (osp/0.2). */
export async function createGenesisRecord(soul: Ed25519Keypair): Promise<CreateRecordResult> {
  return createRecord({
    spec: OSP_SPEC_V02,
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

/** Build a signed arrival attestation with door cosignature (osp/0.2). */
export async function createArrivalRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair,
  seq: number,
  prev: string
): Promise<CreateRecordResult> {
  const fields = {
    spec: OSP_SPEC_V02,
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

/** Build a signed memory shard with door cosignature (osp/0.2 side blobs). */
export async function createShardRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string,
  opts: { store: SoulStore; journal?: string; candidateCid?: string }
): Promise<CreateRecordResult> {
  const textRefs = await putShardText(opts.store, text);
  const body: {
    kind: "shard";
    text_cid: string;
    text_hash: string;
    distilled_at: string;
    journal_cid?: string;
    journal_hash?: string;
    candidate_cid?: string;
  } = {
    kind: "shard",
    text_cid: textRefs.text_cid,
    text_hash: textRefs.text_hash,
    distilled_at: "2026-01-02T01:00:00.000Z"
  };
  if (opts.journal !== undefined) {
    const journalRefs = await putJournal(opts.store, opts.journal);
    body.journal_cid = journalRefs.journal_cid;
    body.journal_hash = journalRefs.journal_hash;
  }
  if (opts.candidateCid !== undefined) {
    body.candidate_cid = opts.candidateCid;
  }

  const fields = {
    spec: OSP_SPEC_V02,
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

/** Build a signed quarantine candidate memory (osp/0.2 side blob). */
export async function createCandidateRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string,
  opts: { store: SoulStore }
): Promise<CreateRecordResult> {
  const textRefs = await putShardText(opts.store, text);
  return createRecord({
    spec: OSP_SPEC_V02,
    seq,
    prev,
    type: "memory",
    body: {
      kind: "candidate",
      text_cid: textRefs.text_cid,
      text_hash: textRefs.text_hash,
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
    spec: OSP_SPEC_V02,
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
    spec: OSP_SPEC_V02,
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
    doorPublicKeys: fixtureDoorPublicKeys()
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

  const shardA = await createShardRecord(SOUL, DOOR, 2, arrival.cid, SHARD_A_TEXT, { store });
  await store.append(shardA.record);

  const shardB = await createShardRecord(SOUL, DOOR, 3, shardA.cid, SHARD_B_TEXT, {
    store,
    journal: JOURNAL_TEXT
  });
  await store.append(shardB.record);

  const candidate = await createCandidateRecord(SOUL, 4, shardB.cid, CANDIDATE_TEXT, { store });
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
    doorPublicKeys: fixtureDoorPublicKeys(),
    shardRecords: [shardA.record, shardB.record]
  };
}
