import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

import { canonicalize } from "../canonical.js";

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
