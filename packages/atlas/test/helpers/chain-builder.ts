import {
  createRecord,
  encodePublicKey,
  signCore,
  type CreateRecordResult,
  type Ed25519Keypair
} from "@npc/osp-core";

import {
  DOOR,
  DOOR_ID,
  OTHER_DOOR,
  OTHER_DOOR_ID,
  RESIDENCY_1,
  RESIDENCY_2,
  SESSION,
  SOUL
} from "./fixed-keys.js";

const CHARTER = "# Wanderer\n\nI travel the doors.";

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
  prev: string,
  doorId: string,
  epoch: number,
  residency: string,
  at: string
): Promise<CreateRecordResult> {
  const fields = {
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: "pop/0.1" as const,
      door_id: doorId,
      epoch,
      session_pubkey: encodePublicKey(session.publicKey),
      at
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
export async function createHeartbeatRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair,
  seq: number,
  prev: string,
  doorId: string,
  epoch: number,
  residency: string,
  at: string
): Promise<CreateRecordResult> {
  const fields = {
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "heartbeat" as const,
      pop_version: "pop/0.1" as const,
      door_id: doorId,
      epoch,
      session_pubkey: encodePublicKey(session.publicKey),
      at
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
export async function createDepartureRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  doorId: string,
  epoch: number,
  residency: string,
  at: string
): Promise<CreateRecordResult> {
  const fields = {
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "departure" as const,
      pop_version: "pop/0.1" as const,
      door_id: doorId,
      epoch,
      at
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

/** Build a signed travel attestation (no door cosignature). */
export async function createTravelRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  fromDoorId: string,
  fromEpoch: number,
  residency: string,
  at: string,
  toDoorId?: string
): Promise<CreateRecordResult> {
  const body: {
    kind: "travel";
    pop_version: "pop/0.1";
    from_door_id: string;
    from_epoch: number;
    at: string;
    to_door_id?: string;
  } = {
    kind: "travel",
    pop_version: "pop/0.1",
    from_door_id: fromDoorId,
    from_epoch: fromEpoch,
    at
  };
  if (toDoorId !== undefined) {
    body.to_door_id = toDoorId;
  }

  return createRecord({
    seq,
    prev,
    type: "attestation",
    body,
    residency,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed memory shard with optional journal and door cosignature. */
export async function createShardRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string,
  residency: string,
  opts?: { journal?: string; distilled_at?: string }
): Promise<CreateRecordResult> {
  const body: {
    kind: "shard";
    text: string;
    distilled_at: string;
    journal?: string;
  } = {
    kind: "shard",
    text,
    distilled_at: opts?.distilled_at ?? "2026-01-02T01:00:00.000Z"
  };
  if (opts?.journal !== undefined) {
    body.journal = opts.journal;
  }

  const fields = {
    seq,
    prev,
    type: "memory" as const,
    body,
    residency
  };
  const cosig = signCore(fields, door.privateKey);
  return createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
}

/** Convenience defaults for residency 1 test chains. */
export const DEFAULT_DOOR = DOOR;
export const DEFAULT_SESSION = SESSION;
export const DEFAULT_RESIDENCY = RESIDENCY_1;
export const DEFAULT_DOOR_ID = DOOR_ID;
export const DEFAULT_OTHER_DOOR = OTHER_DOOR;
export const DEFAULT_OTHER_DOOR_ID = OTHER_DOOR_ID;
export const DEFAULT_RESIDENCY_2 = RESIDENCY_2;
export const DEFAULT_SOUL = SOUL;
