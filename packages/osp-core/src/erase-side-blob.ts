import type { z } from "zod";

import { StorageError } from "./errors.js";
import { createRecord } from "./record.js";
import { OSP_SPEC_V02, TombstoneReasonSchema } from "./schemas/body.js";
import type { SoulStore } from "./store/types.js";

/** Closed tombstone reason enum value. */
export type TombstoneReason = z.infer<typeof TombstoneReasonSchema>;

/** Options for {@link eraseSideBlob}. */
export type EraseSideBlobOptions = {
  store: SoulStore;
  soulPrivateKey: Uint8Array;
  /** CID of the memory record whose prose blob is erased. */
  targetCid: string;
  /** CID of the side blob to delete (must be that record's text_cid or journal_cid). */
  blobCid: string;
  reason: TombstoneReason;
  /** ISO-8601 UTC timestamp of erasure. */
  erasedAt: string;
};

/** Result of {@link eraseSideBlob}. */
export type EraseSideBlobResult = {
  tombstoneCid: string;
};

/**
 * Collect prose blob CIDs referenced by an osp/0.2 memory shard or candidate.
 *
 * @throws StorageError when the target is not an erasable memory record
 */
function referencedProseBlobCids(target: Awaited<ReturnType<SoulStore["get"]>>): Set<string> {
  if (target.type !== "memory") {
    throw new StorageError(
      `eraseSideBlob: targetCid must reference a memory record, got type ${target.type}`
    );
  }

  const body = target.body;
  if (body.kind !== "shard" && body.kind !== "candidate") {
    throw new StorageError(
      `eraseSideBlob: targetCid must be a shard or candidate, got kind ${body.kind}`
    );
  }

  const refs = new Set<string>();
  if ("text_cid" in body && body.text_cid !== undefined) {
    refs.add(body.text_cid);
  }
  if ("journal_cid" in body && body.journal_cid !== undefined) {
    refs.add(body.journal_cid);
  }

  if (refs.size === 0) {
    throw new StorageError(
      "eraseSideBlob: target memory record has no text_cid/journal_cid (not osp/0.2 prose)"
    );
  }

  return refs;
}

/**
 * Erase an osp/0.2 side blob and append a verifiable tombstone.
 *
 * Validates that `blobCid` is the target memory record's `text_cid` or
 * `journal_cid` before deleting — side blobs share the store's record block
 * namespace, so deleting an arbitrary CID could unlink chain record bytes.
 *
 * Order: validate → delete/unpin the blob → append the tombstone so a crash
 * between delete and append leaves either (blob gone, no tombstone) or
 * (tombstone present). Callers may retry; delete is idempotent and a second
 * tombstone for the same blob is allowed by schema (ops should avoid duplicates).
 */
export async function eraseSideBlob(options: EraseSideBlobOptions): Promise<EraseSideBlobResult> {
  const target = await options.store.get(options.targetCid);
  const allowedBlobCids = referencedProseBlobCids(target);
  if (!allowedBlobCids.has(options.blobCid)) {
    throw new StorageError(
      `eraseSideBlob: blobCid ${options.blobCid} is not text_cid/journal_cid on target ${options.targetCid}`
    );
  }

  await options.store.deleteSideBlob(options.blobCid);

  const head = await options.store.head();
  if (head === null) {
    throw new StorageError("eraseSideBlob: store has no head");
  }

  const { record, cid } = await createRecord({
    spec: OSP_SPEC_V02,
    seq: head.seq + 1,
    prev: head.cid,
    type: "tombstone",
    body: {
      target_cid: options.targetCid,
      blob_cid: options.blobCid,
      reason: options.reason,
      erased_at: options.erasedAt
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: options.soulPrivateKey
  });

  await options.store.append(record);
  return { tombstoneCid: cid };
}
