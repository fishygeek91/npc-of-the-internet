import { createHash } from "node:crypto";

import { canonicalize, encodeBase64Url, encodePublicKey, type OspRecord } from "@npc/osp-core";

import type { ChainSnapshot } from "./chain-view.js";

/**
 * `GET /chain/export` body (`spec/door/web.md`).
 * `verified` is intentionally absent: the browser verifies the records itself.
 */
export type ChainExportBody = {
  /** Full OSP records in chain order. */
  records: OspRecord[];
  /** Door id → base64url Ed25519 public key from `ATLAS_DOOR_PUBKEYS`. */
  doorPublicKeys: Record<string, string>;
  /**
   * Journal side-blob CID → base64url bytes. Shard `text_cid` blobs are omitted.
   * A CID named by any tombstone `blob_cid` is omitted. A missing CID is unavailable, not erased.
   */
  blobs: Record<string, string>;
};

/**
 * Build the public export from a snapshot and the configured door public keys.
 * Those keys come only from `ATLAS_DOOR_PUBKEYS`. `encodePublicKey` rejects a
 * value that is not 32 bytes and names the length, not the key bytes.
 */
export function buildChainExport(
  snapshot: ChainSnapshot,
  doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined
): ChainExportBody {
  const records = [...snapshot.records];
  return {
    records,
    doorPublicKeys: encodeDoorPublicKeys(doorPublicKeys),
    blobs: encodeJournalBlobs(records, snapshot.sideBlobs)
  };
}

/**
 * Strong `ETag` for a successful export. Any change to records, door public
 * keys, or included journal blobs changes the tag.
 */
export function chainExportEtag(body: ChainExportBody): string {
  const digest = createHash("sha256").update(canonicalize(body)).digest("base64url");
  return `"${digest}"`;
}

/**
 * True when `If-None-Match` asks for the current export (`*` or a matching tag).
 * Weak validators (`W/"…"`) match the same quoted tag.
 */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const trimmed = header.trim();
  if (trimmed === "") {
    return false;
  }
  if (trimmed === "*") {
    return true;
  }
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    const bare = token.startsWith("W/") || token.startsWith("w/") ? token.slice(2).trim() : token;
    if (bare === etag) {
      return true;
    }
  }
  return false;
}

/** Join a Fastify header value that may be repeated. */
export function headerSingle(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Configured `ATLAS_DOOR_PUBKEYS` entries, base64url, door ids sorted. The map holds public keys only. */
function encodeDoorPublicKeys(
  doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined
): Record<string, string> {
  if (doorPublicKeys === undefined) {
    return {};
  }
  const encoded: Record<string, string> = {};
  for (const doorId of Object.keys(doorPublicKeys).sort()) {
    const publicKey = doorPublicKeys[doorId];
    if (publicKey === undefined) {
      continue;
    }
    encoded[doorId] = encodePublicKey(publicKey);
  }
  return encoded;
}

/**
 * Journal blobs only. Shard text stays out of this response so the export is
 * not a residency transcript (`spec/door/web.md`). Tombstoned CIDs are omitted
 * even when the bytes are still in the snapshot, matching `/journals`.
 */
function encodeJournalBlobs(
  records: readonly OspRecord[],
  sideBlobs: ReadonlyMap<string, Uint8Array> | undefined
): Record<string, string> {
  const blobs: Record<string, string> = {};
  if (sideBlobs === undefined) {
    return blobs;
  }
  const erased = tombstonedBlobCids(records);
  const cids = new Set<string>();
  for (const record of records) {
    const cid = journalCidOf(record);
    if (cid !== null && !erased.has(cid)) {
      cids.add(cid);
    }
  }
  for (const cid of [...cids].sort()) {
    const bytes = sideBlobs.get(cid);
    if (bytes !== undefined) {
      blobs[cid] = encodeBase64Url(bytes);
    }
  }
  return blobs;
}

/** Blob CIDs named by a tombstone anywhere on the chain. Same scan as `derive.ts`. */
function tombstonedBlobCids(records: readonly OspRecord[]): Set<string> {
  const erased = new Set<string>();
  for (const record of records) {
    if (record.type === "tombstone") {
      erased.add(record.body.blob_cid);
    }
  }
  return erased;
}

/** `journal_cid` on an osp/0.2 journal record or a shard that embeds one. */
function journalCidOf(record: OspRecord): string | null {
  if (record.type !== "memory") {
    return null;
  }
  const body = record.body;
  if (body.kind === "journal") {
    return body.journal_cid;
  }
  if (body.kind === "shard" && "journal_cid" in body && body.journal_cid !== undefined) {
    return body.journal_cid;
  }
  return null;
}
