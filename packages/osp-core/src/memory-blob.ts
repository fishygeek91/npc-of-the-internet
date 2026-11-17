import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

import { canonicalize } from "./canonical.js";
import { computeCidFromCanonicalBytes } from "./crypto/cid.js";
import { decodeBase64Url, encodeBase64Url } from "./encoding/base64url.js";
import { EncodingError, SchemaError } from "./errors.js";

const MEMORY_TEXT_MAX_CODE_POINTS = 500;
const SHA256_DIGEST_LENGTH = 32;

/** Count Unicode code points in a string (not UTF-16 code units). */
function countCodePoints(text: string): number {
  return [...text].length;
}

/**
 * Encode memory or journal prose as side-blob bytes.
 *
 * Normative format (`osp/0.2`): UTF-8 bytes of the canonical JSON serialization
 * of a JSON string whose value is the prose. CID uses dag-json + sha2-256 (`bagu…`).
 */
export function encodeMemoryTextBlob(
  text: string,
  options?: { maxCodePoints?: number }
): Uint8Array {
  if (typeof text !== "string") {
    throw new SchemaError("memory text blob must encode a string");
  }
  const maxCodePoints = options?.maxCodePoints;
  if (maxCodePoints !== undefined && countCodePoints(text) > maxCodePoints) {
    throw new SchemaError(`memory text must be at most ${maxCodePoints} Unicode code points`);
  }
  return canonicalize(text);
}

/**
 * Decode side-blob bytes produced by {@link encodeMemoryTextBlob}.
 * Rejects non-string JSON and optional max code-point violations.
 */
export function decodeMemoryTextBlob(
  bytes: Uint8Array,
  options?: { maxCodePoints?: number }
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new EncodingError("memory text blob is not valid JSON");
  }
  if (typeof parsed !== "string") {
    throw new EncodingError("memory text blob must be a JSON string");
  }
  const maxCodePoints = options?.maxCodePoints;
  if (maxCodePoints !== undefined && countCodePoints(parsed) > maxCodePoints) {
    throw new SchemaError(`memory text must be at most ${maxCodePoints} Unicode code points`);
  }
  return parsed;
}

/** Encode shard text (≤500 Unicode code points) as side-blob bytes. */
export function encodeShardTextBlob(text: string): Uint8Array {
  return encodeMemoryTextBlob(text, { maxCodePoints: MEMORY_TEXT_MAX_CODE_POINTS });
}

/** Decode shard text side-blob bytes (enforces ≤500 Unicode code points). */
export function decodeShardTextBlob(bytes: Uint8Array): string {
  return decodeMemoryTextBlob(bytes, { maxCodePoints: MEMORY_TEXT_MAX_CODE_POINTS });
}

/** Encode journal markdown as side-blob bytes (no length cap). */
export function encodeJournalBlob(markdown: string): Uint8Array {
  return encodeMemoryTextBlob(markdown);
}

/** Decode journal markdown side-blob bytes. */
export function decodeJournalBlob(bytes: Uint8Array): string {
  return decodeMemoryTextBlob(bytes);
}

/** Base64url of the raw sha2-256 digest of `blobBytes`. */
export async function hashBlobBytes(blobBytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(blobBytes);
  return encodeBase64Url(digest.digest);
}

/**
 * True when `cid` is a dag-json sha2-256 CID whose multihash digest equals
 * the base64url `hash` (raw 32-byte sha2-256).
 */
export function cidMatchesHash(cid: string, hash: string): boolean {
  let digest: Uint8Array;
  try {
    digest = CID.parse(cid).multihash.digest;
  } catch {
    return false;
  }
  if (digest.length !== SHA256_DIGEST_LENGTH) {
    return false;
  }
  let hashBytes: Uint8Array;
  try {
    hashBytes = decodeBase64Url(hash);
  } catch {
    return false;
  }
  if (hashBytes.length !== SHA256_DIGEST_LENGTH) {
    return false;
  }
  for (let index = 0; index < SHA256_DIGEST_LENGTH; index += 1) {
    if (digest[index] !== hashBytes[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Throw {@link SchemaError} when CID and hash do not bind the same digest.
 */
export function assertCidMatchesHash(cid: string, hash: string, fieldPrefix: string): void {
  if (!cidMatchesHash(cid, hash)) {
    throw new SchemaError(`${fieldPrefix}_cid digest must match ${fieldPrefix}_hash`);
  }
}

/**
 * Compute CID + content hash for side-blob bytes (dag-json sha2-256 / base64url digest).
 */
export async function contentAddressSideBlob(blobBytes: Uint8Array): Promise<{
  cid: string;
  hash: string;
}> {
  const cid = await computeCidFromCanonicalBytes(blobBytes);
  const hash = await hashBlobBytes(blobBytes);
  assertCidMatchesHash(cid, hash, "text");
  return { cid, hash };
}
