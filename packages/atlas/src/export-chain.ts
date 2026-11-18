import { createHash } from "node:crypto";

import {
  canonicalize,
  CidSchema,
  computeCid,
  encodeBase64Url,
  encodePublicKey,
  type Cid,
  type OspRecord
} from "@npc/osp-core";
import { z } from "zod";

import type { ChainSnapshot } from "./chain-view.js";
import { AtlasError } from "./errors.js";

/**
 * `error.code` when `GET /chain/export?after=` names a CID that is not a
 * record on the chain. The HTTP status is 404. Clients drop their chain and
 * fetch the full export once (`spec/door/web.md`).
 */
export const EXPORT_AFTER_UNKNOWN_CODE = "export_after_unknown";

/** Query boundary for `GET /chain/export`. Unknown keys are ignored. */
const chainExportQuerySchema = z.object({
  after: CidSchema.optional()
});

/**
 * `GET /chain/export` body (`spec/door/web.md`).
 * `verified` is intentionally absent: the browser verifies the records itself.
 */
export type ChainExportBody = {
  /** OSP records in chain order: the full chain, or the tail after `after`. */
  records: OspRecord[];
  /** Door id → base64url Ed25519 public key from `ATLAS_DOOR_PUBKEYS`. */
  doorPublicKeys: Record<string, string>;
  /**
   * Journal side-blob CID → base64url bytes. Shard `text_cid` blobs are omitted.
   * A CID named by any tombstone `blob_cid` on the whole chain is omitted.
   * A missing CID is unavailable, not erased.
   */
  blobs: Record<string, string>;
};

/**
 * Read `after` from a `GET /chain/export` query object.
 *
 * Absent means the full export. When present, the value must already be a
 * bagu CID (`CidSchema`, the anchored `CID_RE`). It is not trimmed or rewritten.
 * A rejection is `invalid_request` (400) and the message does not include the
 * value. This function never returns a value that failed that check.
 *
 * @throws {AtlasError} `invalid_request` when `after` is present and not a CID.
 */
export function parseChainExportAfter(query: unknown): Cid | undefined {
  const parsed = chainExportQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new AtlasError("invalid_request", "after must be a CID", 400);
  }
  return parsed.data.after;
}

/** Record CIDs for one snapshot `records` array. The array identity is the key. */
const recordCidCache = new WeakMap<readonly OspRecord[], readonly Cid[]>();

/**
 * Position of the record whose CID is `after`, or `undefined` when `after`
 * is not a record CID on `records`.
 *
 * `after` is compared to computed record CIDs only. It is never used as a
 * filesystem path. CIDs are cached on the `records` array so a later tail
 * against the same snapshot does not hash the chain again. The current head
 * is checked before that walk, so a caught-up refetch hashes one record.
 */
export async function indexOfExportedRecord(
  records: readonly OspRecord[],
  after: Cid
): Promise<number | undefined> {
  const cached = recordCidCache.get(records);
  if (cached !== undefined) {
    const found = cached.indexOf(after);
    return found < 0 ? undefined : found;
  }

  const last = records.length > 0 ? records[records.length - 1] : undefined;
  if (last !== undefined && (await computeCid(last)) === after) {
    return records.length - 1;
  }

  const cids: Cid[] = [];
  for (const record of records) {
    cids.push(await computeCid(record));
  }
  recordCidCache.set(records, cids);
  const found = cids.indexOf(after);
  return found < 0 ? undefined : found;
}

/**
 * Build the public export from a snapshot and the configured door public keys.
 * Those keys come only from `ATLAS_DOOR_PUBKEYS`. `encodePublicKey` rejects a
 * value that is not 32 bytes and names the length, not the key bytes.
 *
 * `records` defaults to the whole snapshot. A tail passes the records strictly
 * after the cursor. Journal blobs are collected from `records` only.
 * Tombstoned CIDs are taken from the whole snapshot, so a tail omits the same
 * erased journals as the full export. A tombstone included in `records` still
 * carries `body.blob_cid`; that field is the drop signal.
 */
export function buildChainExport(
  snapshot: ChainSnapshot,
  doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined,
  records: readonly OspRecord[] = snapshot.records
): ChainExportBody {
  return {
    records: [...records],
    doorPublicKeys: encodeDoorPublicKeys(doorPublicKeys),
    blobs: encodeJournalBlobs(records, snapshot.sideBlobs, tombstonedBlobCids(snapshot.records))
  };
}

/**
 * Strong `ETag` for a successful export. Any change to records, door public
 * keys, or included journal blobs changes the tag.
 *
 * Pass `after` for a tail. The cursor is part of the preimage, so two tails
 * do not share a tag when their bodies match (two empty tails, one per head).
 * Omit it for the full export: that tag stays a hash of the body alone.
 * A new head changes every earlier tail's body, so the same `after` also
 * changes tag when the chain grows.
 */
export function chainExportEtag(body: ChainExportBody, after?: string): string {
  const preimage = after === undefined ? body : { after, body };
  const digest = createHash("sha256").update(canonicalize(preimage)).digest("base64url");
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
 * Journal blobs referenced by `records`. Shard text stays out of this response
 * so the export is not a residency transcript (`spec/door/web.md`).
 * `erased` is the tombstone set for the whole chain, matching `/journals`.
 */
function encodeJournalBlobs(
  records: readonly OspRecord[],
  sideBlobs: ReadonlyMap<string, Uint8Array> | undefined,
  erased: ReadonlySet<string>
): Record<string, string> {
  const blobs: Record<string, string> = {};
  if (sideBlobs === undefined) {
    return blobs;
  }
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
