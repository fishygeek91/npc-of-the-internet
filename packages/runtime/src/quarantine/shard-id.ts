import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import { QuarantineError } from "./errors.js";

/**
 * Derive a stable shard id from shard text: `shard_` plus the first 32 hex
 * characters of SHA-256(UTF-8(text)).
 */
export function shardIdFromText(text: string): string {
  const digest = sha256(utf8ToBytes(text));
  const hex = bytesToHex(digest);
  return `shard_${hex.slice(0, 32)}`;
}

/**
 * Assign shard ids for a batch of texts via {@link shardIdFromText}.
 * Duplicate texts (or hash collisions) throw — deferred commit must recompute
 * the same bare id from candidate text alone, so suffixes are not allowed.
 */
export function assignShardIds(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const text of texts) {
    const id = shardIdFromText(text);
    if (seen.has(id)) {
      throw new QuarantineError(
        `duplicate shard text produces colliding shard_id ${id}; distill batch texts must be unique`,
        "duplicate_shard_text"
      );
    }
    seen.add(id);
    ids.push(id);
  }

  return ids;
}
