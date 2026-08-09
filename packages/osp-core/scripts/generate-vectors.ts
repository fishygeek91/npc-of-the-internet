/**
 * Generates committed OSP chain verification conformance vectors.
 * Run via: pnpm --filter @npc/osp-core generate:vectors
 *
 * TEST-ONLY: uses deterministic private keys (fill-byte patterns). Never use in production.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import {
  contentAddressSideBlob,
  createRecord,
  encodeJournalBlob,
  encodePublicKey,
  encodeShardTextBlob,
  OSP_SPEC_V01,
  OSP_SPEC_V02,
  signCore,
  type Ed25519Keypair,
  type OspRecord
} from "../src/index.js";
import { encodeBase64Url } from "../src/encoding/base64url.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

const DOOR_ID = "discord:g";
const OTHER_DOOR_ID = "irc:other";
const RESIDENCY = `door:${DOOR_ID}/epoch:1`;
const OTHER_RESIDENCY = `door:${OTHER_DOOR_ID}/epoch:1`;
const OTHER_RESIDENCY_E2 = `door:${OTHER_DOOR_ID}/epoch:2`;
const WRONG_PREV_CID = "bagu" + "a".repeat(57);

/** TEST-ONLY: deterministic Ed25519 keypair from a fixed 32-byte private key fill pattern. */
function testKeypair(fillByte: number): Ed25519Keypair {
  const privateKey = new Uint8Array(32).fill(fillByte);
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** TEST-ONLY soul key (fill 7). */
const SOUL = testKeypair(7);
/** TEST-ONLY door key (fill 8). */
const DOOR = testKeypair(8);
/** TEST-ONLY session key (fill 9). */
const SESSION = testKeypair(9);
/** TEST-ONLY alternate door key for missing_cosigner vectors (fill 10). */
const OTHER_DOOR = testKeypair(10);
/** TEST-ONLY alternate session key for bad_session_continuity vectors (fill 11). */
const OTHER_SESSION = testKeypair(11);

type VectorCase = {
  filename: string;
  description: string;
  expected: string;
  soulPublicKey: string;
  doorPublicKeys: Record<string, string>;
  records: OspRecord[];
  /** Optional side-blob map (CID → base64url bytes) for osp/0.2 vectors. */
  blobs?: Record<string, string>;
};

/** Build a signed genesis record. */
async function createGenesisRecord(
  soul: Ed25519Keypair,
  options?: { spec?: typeof OSP_SPEC_V01 | typeof OSP_SPEC_V02 }
) {
  return createRecord({
    spec: options?.spec ?? OSP_SPEC_V01,
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
  prev: string,
  options?: {
    doorId?: string;
    residency?: string;
    epoch?: number;
    at?: string;
    spec?: typeof OSP_SPEC_V01 | typeof OSP_SPEC_V02;
  }
) {
  const doorId = options?.doorId ?? DOOR_ID;
  const residency = options?.residency ?? RESIDENCY;
  const epoch = options?.epoch ?? 1;
  const fields = {
    spec: options?.spec ?? OSP_SPEC_V01,
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: "pop/0.1" as const,
      door_id: doorId,
      epoch,
      session_pubkey: encodePublicKey(session.publicKey),
      at: options?.at ?? "2026-01-02T00:00:00.000Z"
    },
    residency
  };
  const cosig = signCore(fields, door.privateKey);
  return createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed heartbeat attestation with door cosignature. */
async function createHeartbeatRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair,
  seq: number,
  prev: string,
  options?: {
    doorId?: string;
    residency?: string;
    epoch?: number;
    at?: string;
  }
) {
  const doorId = options?.doorId ?? DOOR_ID;
  const residency = options?.residency ?? RESIDENCY;
  const epoch = options?.epoch ?? 1;
  const fields = {
    spec: OSP_SPEC_V01,
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "heartbeat" as const,
      pop_version: "pop/0.1" as const,
      door_id: doorId,
      epoch,
      session_pubkey: encodePublicKey(session.publicKey),
      at: options?.at ?? "2026-01-02T00:30:00.000Z"
    },
    residency
  };
  const cosig = signCore(fields, door.privateKey);
  return createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed departure attestation with door cosignature. */
async function createDepartureRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  options?: {
    doorId?: string;
    residency?: string;
    epoch?: number;
    at?: string;
  }
) {
  const doorId = options?.doorId ?? DOOR_ID;
  const residency = options?.residency ?? RESIDENCY;
  const epoch = options?.epoch ?? 1;
  const fields = {
    spec: OSP_SPEC_V01,
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "departure" as const,
      pop_version: "pop/0.1" as const,
      door_id: doorId,
      epoch,
      at: options?.at ?? "2026-01-03T00:00:00.000Z"
    },
    residency
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
  text: string,
  candidateCid?: string
) {
  const body: {
    kind: "shard";
    text: string;
    distilled_at: string;
    candidate_cid?: string;
  } = {
    kind: "shard",
    text,
    distilled_at: "2026-01-02T01:00:00.000Z"
  };
  if (candidateCid !== undefined) {
    body.candidate_cid = candidateCid;
  }
  const fields = {
    spec: OSP_SPEC_V01,
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

/** Build a signed osp/0.2 memory shard with side-blob text (and optional journal). */
async function createShardRecordV02(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string,
  options?: { candidateCid?: string; journal?: string }
): Promise<{
  result: Awaited<ReturnType<typeof createRecord>>;
  blobs: Record<string, string>;
}> {
  const textBytes = encodeShardTextBlob(text);
  const textAddr = await contentAddressSideBlob(textBytes);
  const blobs: Record<string, string> = {
    [textAddr.cid]: encodeBase64Url(textBytes)
  };
  const body: {
    kind: "shard";
    text_cid: string;
    text_hash: string;
    distilled_at: string;
    candidate_cid?: string;
    journal_cid?: string;
    journal_hash?: string;
  } = {
    kind: "shard",
    text_cid: textAddr.cid,
    text_hash: textAddr.hash,
    distilled_at: "2026-01-02T01:00:00.000Z"
  };
  if (options?.candidateCid !== undefined) {
    body.candidate_cid = options.candidateCid;
  }
  if (options?.journal !== undefined) {
    const journalBytes = encodeJournalBlob(options.journal);
    const journalAddr = await contentAddressSideBlob(journalBytes);
    body.journal_cid = journalAddr.cid;
    body.journal_hash = journalAddr.hash;
    blobs[journalAddr.cid] = encodeBase64Url(journalBytes);
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
  const result = await createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
  return { result, blobs };
}

/** Build a signed osp/0.2 tombstone (soul-signed, residency null). */
async function createTombstoneRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  targetCid: string,
  blobCid: string,
  reason: "erasure_request" | "dmca" | "illegal_content" | "operator"
) {
  return createRecord({
    spec: OSP_SPEC_V02,
    seq,
    prev,
    type: "tombstone",
    body: {
      target_cid: targetCid,
      blob_cid: blobCid,
      reason,
      erased_at: "2026-01-03T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed quarantine candidate memory (no door cosignature). */
async function createCandidateRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string
) {
  return createRecord({
    spec: OSP_SPEC_V01,
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
async function createRejectedRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  category: string,
  candidateCid?: string
) {
  const body: {
    kind: "rejected";
    category: string;
    rejected_at: string;
    candidate_cid?: string;
  } = {
    kind: "rejected",
    category,
    rejected_at: "2026-01-02T02:00:00.000Z"
  };
  if (candidateCid !== undefined) {
    body.candidate_cid = candidateCid;
  }
  return createRecord({
    spec: OSP_SPEC_V01,
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
async function createDriftRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  evidence: string[],
  options?: { spec?: typeof OSP_SPEC_V02; summary?: string }
) {
  return createRecord({
    spec: options?.spec ?? OSP_SPEC_V01,
    seq,
    prev,
    type: "drift",
    body: {
      summary: options?.summary ?? "I feel more patient after the long stay.",
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

/** Tamper one character in a base64url signature string. */
function tamperSignature(sig: string): string {
  const index = 4;
  const replacement = sig[index] === "A" ? "B" : "A";
  return sig.slice(0, index) + replacement + sig.slice(index + 1);
}

/** Clone a record and apply a shallow mutation. */
function mutateRecord<T extends OspRecord>(record: T, mutate: (draft: T) => void): T {
  const clone = structuredClone(record);
  mutate(clone);
  return clone;
}

async function buildVectors(): Promise<VectorCase[]> {
  const soulPub = encodePublicKey(SOUL.publicKey);
  const doorPub = encodePublicKey(DOOR.publicKey);
  const otherDoorPub = encodePublicKey(OTHER_DOOR.publicKey);
  const discordDoorKeys: Record<string, string> = { [DOOR_ID]: doorPub };
  const bothDoorKeys: Record<string, string> = {
    [DOOR_ID]: doorPub,
    [OTHER_DOOR_ID]: otherDoorPub
  };

  const chain = await createValidMiniChain(SOUL, DOOR, SESSION);

  const validMiniChain: VectorCase = {
    filename: "valid-mini-chain.json",
    description: "Valid genesis → arrival → shard → drift chain with matching evidence CID",
    expected: "valid",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [chain.genesis.record, chain.arrival.record, chain.shard.record, chain.drift.record]
  };

  const badSoulSig: VectorCase = {
    filename: "bad-soul-sig.json",
    description: "Tampered soul signature on the shard record",
    expected: "bad_soul_sig",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      chain.arrival.record,
      mutateRecord(chain.shard.record, (draft) => {
        draft.sig = tamperSignature(draft.sig);
      }),
      chain.drift.record
    ]
  };

  const brokenShard = await createShardRecord(SOUL, DOOR, 2, WRONG_PREV_CID, "Broken prev link.");
  const brokenPrevLink: VectorCase = {
    filename: "broken-prev-link.json",
    description: "Shard record prev does not match the CID of the prior record",
    expected: "broken_prev_link",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [chain.genesis.record, chain.arrival.record, brokenShard.record, chain.drift.record]
  };

  const gapShard = await createShardRecord(SOUL, DOOR, 4, chain.arrival.cid, "Sequence gap.");
  const seqGap: VectorCase = {
    filename: "seq-gap.json",
    description: "Sequence jumps from 1 to 4 (expected 2)",
    expected: "seq_gap",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [chain.genesis.record, chain.arrival.record, gapShard.record]
  };

  const schemaViolation: VectorCase = {
    filename: "schema-violation.json",
    description: "Unsupported spec version on an arrival record",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      mutateRecord(chain.arrival.record, (draft) => {
        draft.spec = "osp/9.9";
      }),
      chain.shard.record,
      chain.drift.record
    ]
  };

  const missingCosigner: VectorCase = {
    filename: "missing-cosigner.json",
    description: "Cosignatures verify under door A but doorPublicKeys lists only door B",
    expected: "missing_cosigner",
    soulPublicKey: soulPub,
    doorPublicKeys: { [OTHER_DOOR_ID]: otherDoorPub },
    records: [chain.genesis.record, chain.arrival.record, chain.shard.record, chain.drift.record]
  };

  const forkedArrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, chain.genesis.cid);
  const forkedHead: VectorCase = {
    filename: "forked-head.json",
    description: "Two distinct arrival records share seq 1",
    expected: "forked_head",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      chain.arrival.record,
      forkedArrival.record,
      chain.shard.record,
      chain.drift.record
    ]
  };

  const badDrift = await createDriftRecord(SOUL, 3, chain.shard.cid, [WRONG_PREV_CID]);
  const badDriftEvidence: VectorCase = {
    filename: "bad-drift-evidence.json",
    description: "Drift evidence cites a CID that is not an earlier shard on this chain",
    expected: "bad_drift_evidence",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [chain.genesis.record, chain.arrival.record, chain.shard.record, badDrift.record]
  };

  const badGenesis: VectorCase = {
    filename: "bad-genesis.json",
    description: "Chain begins with an arrival attestation instead of genesis",
    expected: "bad_genesis",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [chain.arrival.record, chain.shard.record, chain.drift.record]
  };

  const schemaBadResidency: VectorCase = {
    filename: "schema-bad-residency.json",
    description: "Residency string missing required door: prefix and epoch suffix",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      mutateRecord(chain.arrival.record, (draft) => {
        draft.residency = "discord:g/epoch:1";
      })
    ]
  };

  const schemaBadCandidateCid: VectorCase = {
    filename: "schema-bad-candidate-cid.json",
    description: "Shard candidate_cid is not a valid bagu CID string",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      chain.arrival.record,
      mutateRecord(chain.shard.record, (draft) => {
        if (draft.body.kind === "shard") {
          draft.body.candidate_cid = "../../../etc/passwd";
        }
      })
    ]
  };

  const schemaDoorIdMismatch: VectorCase = {
    filename: "schema-door-id-mismatch.json",
    description: "Arrival door_id does not match the Door portion of residency",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      mutateRecord(chain.arrival.record, (draft) => {
        if (draft.body.kind === "arrival") {
          draft.body.door_id = "discord:wrong";
        }
      })
    ]
  };

  const genesisCosig = signCore(
    {
      seq: 0,
      prev: null,
      type: "genesis",
      body: chain.genesis.record.body,
      residency: null
    },
    DOOR.privateKey
  );
  const schemaGenesisCosigners: VectorCase = {
    filename: "schema-genesis-cosigners.json",
    description: "Genesis record must have an empty cosigners array",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      mutateRecord(chain.genesis.record, (draft) => {
        draft.cosigners = [genesisCosig];
      })
    ]
  };

  const schemaBadKeyLength: VectorCase = {
    filename: "schema-bad-key-length.json",
    description: "Genesis soul_pubkey is not a valid 32-byte Ed25519 public key encoding",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      mutateRecord(chain.genesis.record, (draft) => {
        if (draft.body.soul_pubkey !== undefined) {
          draft.body.soul_pubkey = "too-short";
        }
      })
    ]
  };

  const schemaBadPrev: VectorCase = {
    filename: "schema-bad-prev.json",
    description: "Record prev is not a valid bagu CID string",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      mutateRecord(chain.arrival.record, (draft) => {
        draft.prev = "../../../etc/passwd";
      })
    ]
  };

  const schemaBadEvidence: VectorCase = {
    filename: "schema-bad-evidence.json",
    description: "Drift evidence entry is not a valid bagu CID string",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      chain.arrival.record,
      chain.shard.record,
      mutateRecord(chain.drift.record, (draft) => {
        if (draft.body.evidence !== undefined) {
          draft.body.evidence[0] = "../../../etc/passwd";
        }
      })
    ]
  };

  const quarantineGenesis = await createGenesisRecord(SOUL);
  const quarantineArrival = await createArrivalRecord(
    SOUL,
    DOOR,
    SESSION,
    1,
    quarantineGenesis.cid
  );
  const quarantineCandidate = await createCandidateRecord(
    SOUL,
    2,
    quarantineArrival.cid,
    "A quarantine candidate awaiting review."
  );
  const promotedShard = await createShardRecord(
    SOUL,
    DOOR,
    3,
    quarantineCandidate.cid,
    "Committed shard after quarantine.",
    quarantineCandidate.cid
  );
  const quarantineCandidateToShard: VectorCase = {
    filename: "quarantine-candidate-to-shard.json",
    description:
      "Valid genesis → arrival → candidate → shard with candidate_cid linkage and door cosignature",
    expected: "valid",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      quarantineGenesis.record,
      quarantineArrival.record,
      quarantineCandidate.record,
      promotedShard.record
    ]
  };

  const rejectGenesis = await createGenesisRecord(SOUL);
  const rejectArrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, rejectGenesis.cid);
  const rejectCandidate = await createCandidateRecord(
    SOUL,
    2,
    rejectArrival.cid,
    "A candidate destined for rejection."
  );
  const rejectedRecord = await createRejectedRecord(
    SOUL,
    3,
    rejectCandidate.cid,
    "injection",
    rejectCandidate.cid
  );
  const quarantineCandidateToRejected: VectorCase = {
    filename: "quarantine-candidate-to-rejected.json",
    description:
      "Valid genesis → arrival → candidate → rejected with candidate_cid, category, and rejected_at",
    expected: "valid",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      rejectGenesis.record,
      rejectArrival.record,
      rejectCandidate.record,
      rejectedRecord.record
    ]
  };

  const schemaRejectedWithPayload: VectorCase = {
    filename: "schema-rejected-with-payload.json",
    description: "Rejected memory body includes smuggled text field (fails .strict schema)",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      rejectGenesis.record,
      rejectArrival.record,
      rejectCandidate.record,
      mutateRecord(rejectedRecord.record, (draft) => {
        if (draft.body.kind === "rejected") {
          Object.assign(draft.body, { text: "must not appear" });
        }
      })
    ]
  };

  const wrongDoorCosignFields = {
    seq: 1,
    prev: chain.genesis.cid,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: "pop/0.1" as const,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: encodePublicKey(SESSION.publicKey),
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY
  };
  const wrongDoorCosig = signCore(wrongDoorCosignFields, OTHER_DOOR.privateKey);
  const wrongDoorArrival = await createRecord({
    ...wrongDoorCosignFields,
    cosigners: [wrongDoorCosig],
    soulPrivateKey: SOUL.privateKey
  });
  const wrongDoorCosign: VectorCase = {
    filename: "wrong-door-cosign.json",
    description:
      "doorPublicKeys lists both Doors but cosignature verifies only under the non-residency Door",
    expected: "missing_cosigner",
    soulPublicKey: soulPub,
    doorPublicKeys: bothDoorKeys,
    records: [chain.genesis.record, wrongDoorArrival.record]
  };

  const sessionGenesis = await createGenesisRecord(SOUL);
  const sessionArrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, sessionGenesis.cid);
  const mismatchedHeartbeat = await createHeartbeatRecord(
    SOUL,
    DOOR,
    OTHER_SESSION,
    2,
    sessionArrival.cid
  );
  const badSessionContinuity: VectorCase = {
    filename: "bad-session-continuity.json",
    description: "Heartbeat session_pubkey differs from the open arrival session for the epoch",
    expected: "bad_session_continuity",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [sessionGenesis.record, sessionArrival.record, mismatchedHeartbeat.record]
  };

  const schemaEpochMismatch: VectorCase = {
    filename: "schema-epoch-mismatch.json",
    description: "Arrival body.epoch does not match the epoch portion of residency",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      chain.genesis.record,
      mutateRecord(chain.arrival.record, (draft) => {
        if (draft.body.kind === "arrival") {
          draft.body.epoch = 2;
        }
      })
    ]
  };

  const dualCosigShardFields = {
    seq: 2,
    prev: chain.arrival.cid,
    type: "memory" as const,
    body: {
      kind: "shard" as const,
      text: "Shard with two Door cosignatures.",
      distilled_at: "2026-01-02T01:00:00.000Z"
    },
    residency: RESIDENCY
  };
  const dualCosigShard = await createRecord({
    ...dualCosigShardFields,
    cosigners: [
      signCore(dualCosigShardFields, DOOR.privateKey),
      signCore(dualCosigShardFields, OTHER_DOOR.privateKey)
    ],
    soulPrivateKey: SOUL.privateKey
  });
  const schemaUnsortedCosigners: VectorCase = {
    filename: "schema-unsorted-cosigners.json",
    description: "Two cosigner signatures are not in strictly ascending lexicographic order",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: bothDoorKeys,
    records: [
      chain.genesis.record,
      chain.arrival.record,
      mutateRecord(dualCosigShard.record, (draft) => {
        draft.cosigners = [...draft.cosigners].reverse();
      })
    ]
  };

  const conflictGenesis = await createGenesisRecord(SOUL);
  const conflictArrivalA = await createArrivalRecord(SOUL, DOOR, SESSION, 1, conflictGenesis.cid);
  const conflictArrivalB = await createArrivalRecord(
    SOUL,
    OTHER_DOOR,
    OTHER_SESSION,
    2,
    conflictArrivalA.cid,
    { doorId: OTHER_DOOR_ID, residency: OTHER_RESIDENCY }
  );
  const conflictingAttestations: VectorCase = {
    filename: "conflicting-attestations.json",
    description:
      "Two arrival attestations for epoch 1 at different Doors without an intervening departure",
    expected: "presence_conflict",
    soulPublicKey: soulPub,
    doorPublicKeys: bothDoorKeys,
    records: [conflictGenesis.record, conflictArrivalA.record, conflictArrivalB.record]
  };

  const reuseGenesis = await createGenesisRecord(SOUL);
  const reuseArrivalA = await createArrivalRecord(SOUL, DOOR, SESSION, 1, reuseGenesis.cid);
  const reuseDeparture = await createDepartureRecord(SOUL, DOOR, 2, reuseArrivalA.cid);
  const reuseArrivalB = await createArrivalRecord(
    SOUL,
    OTHER_DOOR,
    OTHER_SESSION,
    3,
    reuseDeparture.cid,
    { doorId: OTHER_DOOR_ID, residency: OTHER_RESIDENCY, epoch: 1 }
  );
  const presenceConflictEpochReuse: VectorCase = {
    filename: "presence-conflict-epoch-reuse.json",
    description:
      "Arrival at door B for epoch 1 after door A already arrived and departed that epoch",
    expected: "presence_conflict",
    soulPublicKey: soulPub,
    doorPublicKeys: bothDoorKeys,
    records: [
      reuseGenesis.record,
      reuseArrivalA.record,
      reuseDeparture.record,
      reuseArrivalB.record
    ]
  };

  const staleGenesis = await createGenesisRecord(SOUL);
  const staleArrivalA = await createArrivalRecord(SOUL, DOOR, SESSION, 1, staleGenesis.cid);
  const staleArrivalB = await createArrivalRecord(
    SOUL,
    OTHER_DOOR,
    OTHER_SESSION,
    2,
    staleArrivalA.cid,
    { doorId: OTHER_DOOR_ID, residency: OTHER_RESIDENCY_E2, epoch: 2 }
  );
  const staleHeartbeat = await createHeartbeatRecord(SOUL, DOOR, SESSION, 3, staleArrivalB.cid, {
    doorId: DOOR_ID,
    residency: RESIDENCY,
    epoch: 1
  });
  const staleHeartbeatAfterNewEpoch: VectorCase = {
    filename: "stale-heartbeat-after-new-epoch.json",
    description:
      "Heartbeat for epoch 1 after a newer arrival retires that session (bad_session_continuity)",
    expected: "bad_session_continuity",
    soulPublicKey: soulPub,
    doorPublicKeys: bothDoorKeys,
    records: [
      staleGenesis.record,
      staleArrivalA.record,
      staleArrivalB.record,
      staleHeartbeat.record
    ]
  };

  const v02Genesis = await createGenesisRecord(SOUL, { spec: OSP_SPEC_V02 });
  const v02Arrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, v02Genesis.cid, {
    spec: OSP_SPEC_V02
  });
  const v02Shard = await createShardRecordV02(
    SOUL,
    DOOR,
    2,
    v02Arrival.cid,
    "I learned a word for leaving gently."
  );
  const validOsp02MiniChain: VectorCase = {
    filename: "valid-osp-0.2-mini-chain.json",
    description: "Valid osp/0.2 mini-chain with side-blob memory text",
    expected: "valid",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [v02Genesis.record, v02Arrival.record, v02Shard.result.record],
    blobs: v02Shard.blobs
  };

  const tombstoneShard = await createShardRecordV02(
    SOUL,
    DOOR,
    2,
    v02Arrival.cid,
    "A memory that will be erased."
  );
  const textBlobCid = Object.keys(tombstoneShard.blobs)[0];
  if (textBlobCid === undefined) {
    throw new Error("expected text blob CID for tombstone vector");
  }
  const tombstone = await createTombstoneRecord(
    SOUL,
    3,
    tombstoneShard.result.cid,
    tombstoneShard.result.cid,
    textBlobCid,
    "erasure_request"
  );
  const validTombstoneAfterShard: VectorCase = {
    filename: "valid-tombstone-after-shard.json",
    description:
      "Valid osp/0.2 chain: shard then tombstone (blob bytes omitted — chain still verifies)",
    expected: "valid",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [v02Genesis.record, v02Arrival.record, tombstoneShard.result.record, tombstone.record]
  };

  // Migration vector: same narrative content as valid-mini-chain, rewritten as osp/0.2.
  const migrateSource = chain;
  const migrateShardText =
    migrateSource.shard.record.type === "memory" &&
    migrateSource.shard.record.body.kind === "shard" &&
    "text" in migrateSource.shard.record.body
      ? migrateSource.shard.record.body.text
      : "A committed shard memory.";
  const migrateGenesis = await createGenesisRecord(SOUL, { spec: OSP_SPEC_V02 });
  const migrateArrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, migrateGenesis.cid, {
    spec: OSP_SPEC_V02
  });
  const migrateShard = await createShardRecordV02(
    SOUL,
    DOOR,
    2,
    migrateArrival.cid,
    migrateShardText
  );
  const migrateDrift = await createDriftRecord(
    SOUL,
    3,
    migrateShard.result.cid,
    [migrateShard.result.cid],
    { spec: OSP_SPEC_V02 }
  );
  const migrate01to02: VectorCase = {
    filename: "migrate-0.1-to-0.2.json",
    description:
      "Deterministic osp/0.1→osp/0.2 migration of the valid mini-chain (text extracted to side blobs)",
    expected: "valid",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      migrateGenesis.record,
      migrateArrival.record,
      migrateShard.result.record,
      migrateDrift.record
    ],
    blobs: migrateShard.blobs
  };

  const tombstoneWithProse = mutateRecord(tombstone.record, (draft) => {
    if (draft.type === "tombstone") {
      (draft.body as { erased_text?: string }).erased_text = "leaked prose must fail schema";
    }
  });
  const schemaTombstoneProse: VectorCase = {
    filename: "schema-tombstone-prose.json",
    description: "Tombstone body carrying free-text / erased prose is a schema_violation",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [
      v02Genesis.record,
      v02Arrival.record,
      tombstoneShard.result.record,
      tombstoneWithProse
    ]
  };

  // Homogeneous osp/0.1 chain with a tombstone (tombstones are osp/0.2-only).
  const tombstoneOnV01 = mutateRecord(tombstone.record, (draft) => {
    draft.spec = "osp/0.1";
    draft.seq = 2;
    draft.prev = chain.arrival.cid;
  });
  const schemaTombstoneV01: VectorCase = {
    filename: "schema-tombstone-v01.json",
    description: "Tombstone record under osp/0.1 is a schema_violation (osp/0.2 only)",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: discordDoorKeys,
    records: [chain.genesis.record, chain.arrival.record, tombstoneOnV01]
  };

  return [
    validMiniChain,
    badSoulSig,
    brokenPrevLink,
    seqGap,
    schemaViolation,
    missingCosigner,
    wrongDoorCosign,
    forkedHead,
    badDriftEvidence,
    badGenesis,
    schemaBadResidency,
    schemaBadCandidateCid,
    schemaDoorIdMismatch,
    schemaEpochMismatch,
    schemaUnsortedCosigners,
    schemaGenesisCosigners,
    schemaBadKeyLength,
    schemaBadPrev,
    schemaBadEvidence,
    badSessionContinuity,
    conflictingAttestations,
    presenceConflictEpochReuse,
    staleHeartbeatAfterNewEpoch,
    quarantineCandidateToShard,
    quarantineCandidateToRejected,
    schemaRejectedWithPayload,
    validOsp02MiniChain,
    validTombstoneAfterShard,
    migrate01to02,
    schemaTombstoneProse,
    schemaTombstoneV01
  ];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(scriptDir, "../../../spec/osp/vectors");

async function main(): Promise<void> {
  mkdirSync(vectorsDir, { recursive: true });

  const vectors = await buildVectors();
  for (const vector of vectors) {
    const { filename, blobs, ...rest } = vector;
    const payload =
      blobs === undefined
        ? rest
        : {
            ...rest,
            blobs
          };
    const path = join(vectorsDir, filename);
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    writeFileSync(path, json, "utf8");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
