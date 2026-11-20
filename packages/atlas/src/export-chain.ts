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

/** 404 `error.code` when `after` is not a record. Clients drop state and full-GET once. */
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
  /** Journal CID → base64url bytes. Shard text and tombstoned CIDs are omitted. */
  blobs: Record<string, string>;
};

/**
 * Read `after` from the export query. Absent means the full export. A present
 * value must already be a bagu CID: it is not trimmed or rewritten. Rejection
 * is `invalid_request` (400) and does not echo the value.
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
 * Index of the record whose CID is `after`, or `undefined` when it is absent.
 * Compared to computed record CIDs only, never a path. CIDs are cached on the
 * array; the head is checked first so a caught-up refetch hashes one record.
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
 * Public export. Door keys come only from `ATLAS_DOOR_PUBKEYS`. `records`
 * defaults to the snapshot; a tail passes the records after the cursor.
 * Journal blobs come from that slice. Tombstoned CIDs come from the whole
 * snapshot. A tombstone in `records` still carries `body.blob_cid`.
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
 * Strong ETag. The full export hashes the body alone. A tail hashes
 * `{ after, body }`, so matching bodies do not share a tag, and the same
 * `after` changes tag when the chain grows.
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
