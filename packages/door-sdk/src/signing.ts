import {
  canonicalize,
  decodeSignature,
  encodeSignature,
  generateKeypair,
  sign,
  verify,
  type Ed25519Keypair
} from "@npc/osp-core";

import type {
  AttestRequest,
  CandidateShard,
  CosignRequest,
  HeartbeatRequest,
  HelloResponse,
  OutboundFrame
} from "./schemas.js";

/** Fields covered by `/door/attest` request `sig` (excludes `protocol_version`). */
export type AttestSigningFields = {
  door_id: string;
  epoch: number;
  kind: AttestRequest["kind"];
  core: string;
  session_pubkey: string;
  issued_at: string;
};

/** Fields covered by `/door/cosign` review request `sig` (excludes `protocol_version`). */
export type CosignReviewSigningFields = {
  door_id: string;
  epoch: number;
  phase: "review";
  session_pubkey: string;
  shards: CandidateShard[];
  issued_at: string;
  farewell?: string;
};

/** Fields covered by `/door/cosign` commit request `sig` (excludes `protocol_version`). */
export type CosignCommitSigningFields = {
  door_id: string;
  epoch: number;
  phase: "commit";
  session_pubkey: string;
  shard_id: string;
  core: string;
  issued_at: string;
};

/** Canonical bytes for arbitrary signed Door wire fields. */
export function signingPayload(fields: Record<string, unknown>): Uint8Array {
  return canonicalize(fields);
}

/** Canonical bytes for `/door/attest` request signatures per `spec/door/api.md`. */
export function attestSigningPayload(request: Omit<AttestRequest, "sig">): Uint8Array {
  const fields: AttestSigningFields = {
    door_id: request.door_id,
    epoch: request.epoch,
    kind: request.kind,
    core: request.core,
    session_pubkey: request.session_pubkey,
    issued_at: request.issued_at
  };
  return canonicalize(fields);
}

/** Canonical bytes for `/door/cosign` review request signatures per `spec/door/api.md`. */
export function cosignReviewSigningPayload(
  request: Omit<Extract<CosignRequest, { phase: "review" }>, "sig">
): Uint8Array {
  const fields: CosignReviewSigningFields = {
    door_id: request.door_id,
    epoch: request.epoch,
    phase: request.phase,
    session_pubkey: request.session_pubkey,
    shards: request.shards,
    issued_at: request.issued_at
  };
  if (request.farewell !== undefined) {
    fields.farewell = request.farewell;
  }
  return canonicalize(fields);
}

/** Canonical bytes for `/door/cosign` commit request signatures per `spec/door/api.md`. */
export function cosignCommitSigningPayload(
  request: Omit<Extract<CosignRequest, { phase: "commit" }>, "sig">
): Uint8Array {
  const fields: CosignCommitSigningFields = {
    door_id: request.door_id,
    epoch: request.epoch,
    phase: request.phase,
    session_pubkey: request.session_pubkey,
    shard_id: request.shard_id,
    core: request.core,
    issued_at: request.issued_at
  };
  return canonicalize(fields);
}

/** Canonical bytes for `/door/heartbeat` request signatures (full unsigned request). */
export function heartbeatSigningPayload(request: Omit<HeartbeatRequest, "sig">): Uint8Array {
  return canonicalize(request);
}

/** Canonical bytes for WebSocket `outbound` frame signatures (full unsigned frame). */
export function outboundSigningPayload(frame: Omit<OutboundFrame, "sig">): Uint8Array {
  return canonicalize(frame);
}

/** Canonical bytes for `/door/session` session binding proof. */
export function sessionBindSigningPayload(fields: {
  door_id: string;
  epoch: number;
  session_pubkey: string;
}): Uint8Array {
  return canonicalize(fields);
}

/** Canonical bytes for `/door/hello` response `sig` (all fields except `sig`). */
export function helloResponseSigningPayload(response: Omit<HelloResponse, "sig">): Uint8Array {
  return canonicalize(response);
}

/**
 * Door co-signature over raw UTF-8 bytes of the OSP `core` string.
 * Returns a base64url-encoded Ed25519 signature.
 */
export function signDoorCosig(core: string, privateKey: Uint8Array): string {
  const coreBytes = new TextEncoder().encode(core);
  return encodeSignature(sign(coreBytes, privateKey));
}

/** Verify a Door co-signature over raw UTF-8 bytes of the OSP `core` string. */
export function verifyDoorCosig(core: string, cosig: string, publicKey: Uint8Array): boolean {
  const coreBytes = new TextEncoder().encode(core);
  return verify(coreBytes, decodeSignature(cosig), publicKey);
}

/** Sign canonical JSON fields with an Ed25519 private key. */
export function signCanonical(fields: Record<string, unknown>, privateKey: Uint8Array): string {
  return encodeSignature(sign(canonicalize(fields), privateKey));
}

/** Verify a canonical JSON signature with an Ed25519 public key. */
export function verifyCanonical(
  fields: Record<string, unknown>,
  sig: string,
  publicKey: Uint8Array
): boolean {
  return verify(canonicalize(fields), decodeSignature(sig), publicKey);
}

/** Generate a Door identity Ed25519 keypair. */
export function generateDoorKeypair(): Ed25519Keypair {
  return generateKeypair();
}
