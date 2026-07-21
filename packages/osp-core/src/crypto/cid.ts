import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { z } from "zod";

import { canonicalize } from "../canonical.js";

/**
 * Anchored regex for CIDv1 dag-json sha2-256 base32 strings produced by
 * {@link computeCidFromCanonicalBytes}: prefix `bagu` plus 57 RFC 4648 base32
 * lowercase characters (`a-z`, `2-7`).
 */
export const CID_RE = /^bagu[a-z2-7]{57}$/;

/**
 * Returns true when `value` matches the CID format emitted by
 * {@link computeCidFromCanonicalBytes}.
 */
export function isValidCid(value: string): boolean {
  return CID_RE.test(value);
}

/** Zod schema for a valid dag-json sha2-256 base32 CID string. */
export const CidSchema = z.string().regex(CID_RE);

/** dag-json multicodec (0x0129) per multiformats/multicodec — codec tag only; bytes are pre-canonicalized. */
const DAG_JSON_CODEC = 0x0129;

/**
 * Compute a CIDv1 base32 string from pre-canonicalized record bytes.
 * Hashes the provided bytes directly (dag-json codec, sha2-256 digest).
 */
export async function computeCidFromCanonicalBytes(canonicalBytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(canonicalBytes);
  const cid = CID.create(1, DAG_JSON_CODEC, digest);
  return cid.toString();
}

/**
 * Canonicalize a value and compute its CID.
 */
export async function computeCid(value: unknown): Promise<string> {
  const canonicalBytes = canonicalize(value);
  return computeCidFromCanonicalBytes(canonicalBytes);
}
