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
  createRecord,
  signCore,
  encodePublicKey,
  type Ed25519Keypair,
  type OspRecord
} from "../src/index.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

const RESIDENCY = "door:discord:g/epoch:1";
const WRONG_PREV_CID = "bagu4eraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

type VectorCase = {
  filename: string;
  description: string;
  expected: string;
  soulPublicKey: string;
  doorPublicKeys: string[];
  records: OspRecord[];
};

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

  const chain = await createValidMiniChain(SOUL, DOOR, SESSION);

  const validMiniChain: VectorCase = {
    filename: "valid-mini-chain.json",
    description: "Valid genesis → arrival → shard → drift chain with matching evidence CID",
    expected: "valid",
    soulPublicKey: soulPub,
    doorPublicKeys: [doorPub],
    records: [chain.genesis.record, chain.arrival.record, chain.shard.record, chain.drift.record]
  };

  const badSoulSig: VectorCase = {
    filename: "bad-soul-sig.json",
    description: "Tampered soul signature on the shard record",
    expected: "bad_soul_sig",
    soulPublicKey: soulPub,
    doorPublicKeys: [doorPub],
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
    doorPublicKeys: [doorPub],
    records: [chain.genesis.record, chain.arrival.record, brokenShard.record, chain.drift.record]
  };

  const gapShard = await createShardRecord(SOUL, DOOR, 4, chain.arrival.cid, "Sequence gap.");
  const seqGap: VectorCase = {
    filename: "seq-gap.json",
    description: "Sequence jumps from 1 to 4 (expected 2)",
    expected: "seq_gap",
    soulPublicKey: soulPub,
    doorPublicKeys: [doorPub],
    records: [chain.genesis.record, chain.arrival.record, gapShard.record]
  };

  const schemaViolation: VectorCase = {
    filename: "schema-violation.json",
    description: "Unsupported spec version on an arrival record",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: [doorPub],
    records: [
      chain.genesis.record,
      mutateRecord(chain.arrival.record, (draft) => {
        draft.spec = "osp/0.2";
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
    doorPublicKeys: [otherDoorPub],
    records: [chain.genesis.record, chain.arrival.record, chain.shard.record, chain.drift.record]
  };

  const forkedArrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, chain.genesis.cid);
  const forkedHead: VectorCase = {
    filename: "forked-head.json",
    description: "Two distinct arrival records share seq 1",
    expected: "forked_head",
    soulPublicKey: soulPub,
    doorPublicKeys: [doorPub],
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
    doorPublicKeys: [doorPub],
    records: [chain.genesis.record, chain.arrival.record, chain.shard.record, badDrift.record]
  };

  const badGenesis: VectorCase = {
    filename: "bad-genesis.json",
    description: "Chain begins with an arrival attestation instead of genesis",
    expected: "bad_genesis",
    soulPublicKey: soulPub,
    doorPublicKeys: [doorPub],
    records: [chain.arrival.record, chain.shard.record, chain.drift.record]
  };

  const schemaBadResidency: VectorCase = {
    filename: "schema-bad-residency.json",
    description: "Residency string missing required door: prefix and epoch suffix",
    expected: "schema_violation",
    soulPublicKey: soulPub,
    doorPublicKeys: [doorPub],
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
    doorPublicKeys: [doorPub],
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
    doorPublicKeys: [doorPub],
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
    doorPublicKeys: [doorPub],
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
    doorPublicKeys: [doorPub],
    records: [
      mutateRecord(chain.genesis.record, (draft) => {
        if (draft.body.soul_pubkey !== undefined) {
          draft.body.soul_pubkey = "too-short";
        }
      })
    ]
  };

  return [
    validMiniChain,
    badSoulSig,
    brokenPrevLink,
    seqGap,
    schemaViolation,
    missingCosigner,
    forkedHead,
    badDriftEvidence,
    badGenesis,
    schemaBadResidency,
    schemaBadCandidateCid,
    schemaDoorIdMismatch,
    schemaGenesisCosigners,
    schemaBadKeyLength
  ];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(scriptDir, "../../../spec/osp/vectors");

async function main(): Promise<void> {
  mkdirSync(vectorsDir, { recursive: true });

  const vectors = await buildVectors();
  for (const vector of vectors) {
    const { filename, ...payload } = vector;
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
