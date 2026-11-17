import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { z } from "zod";

import { canonicalize } from "../canonical.js";
import { EncodingError } from "../errors.js";

/**
 * Anchored regex for CIDv1 dag-json sha2-256 base32 strings produced by
 * {@link computeCidFromCanonicalBytes}: prefix `bagu` plus 57 RFC 4648 base32
 * lowercase characters (`a-z`, `2-7`).
 */
export const CID_RE = /^bagu[a-z2-7]{57}$/;

/**
 * Zod schema for a valid dag-json sha2-256 base32 CID string.
 *
 * `.brand()` is type-only (Zod output direction `"out"`). It does not change
 * the accepted strings or the emitted JSON Schema. Input is still `string`;
 * output is {@link Cid}.
 */
export const CidSchema = z.string().regex(CID_RE).brand<"Cid">();

/**
 * CIDv1 dag-json sha2-256 content id (`bagu…`).
 *
 * A Zod output brand: a plain `string` is not assignable to `Cid`, and `Cid`
 * is assignable to `string`. Construct one with {@link asCid}, {@link parseCid},
 * {@link computeCid}, or `CidSchema` parse — do not cast at call sites.
 */
export type Cid = z.output<typeof CidSchema>;

/**
 * Returns true when `value` matches the CID format emitted by
 * {@link computeCidFromCanonicalBytes}, and narrows it to {@link Cid}.
 */
export function isValidCid(value: string): value is Cid {
  return CID_RE.test(value);
}

/**
 * Parse a CID string. Returns null when {@link isValidCid} rejects it.
 */
export function parseCid(value: string): Cid | null {
  if (!isValidCid(value)) {
    return null;
  }
  return value;
}

/**
 * Require a CID string.
 *
 * @throws {EncodingError} when `value` is not a bagu CIDv1.
 */
export function asCid(value: string): Cid {
  if (!isValidCid(value)) {
    throw new EncodingError("CID must be a dag-json sha2-256 base32 string (bagu…)");
  }
  return value;
}

/** dag-json multicodec (0x0129) per multiformats/multicodec — codec tag only; bytes are pre-canonicalized. */
const DAG_JSON_CODEC = 0x0129;

/**
 * Compute a CIDv1 base32 string from pre-canonicalized record bytes.
 * Hashes the provided bytes directly (dag-json codec, sha2-256 digest).
 *
 * @throws {EncodingError} when the multiformats encoding is not a bagu CIDv1
 *   (not expected for this codec and hash).
 */
export async function computeCidFromCanonicalBytes(canonicalBytes: Uint8Array): Promise<Cid> {
  const digest = await sha256.digest(canonicalBytes);
  const cid = CID.create(1, DAG_JSON_CODEC, digest);
  return asCid(cid.toString());
}

/**
 * Canonicalize a value and compute its CID.
 */
export async function computeCid(value: unknown): Promise<Cid> {
  const canonicalBytes = canonicalize(value);
  return computeCidFromCanonicalBytes(canonicalBytes);
}
