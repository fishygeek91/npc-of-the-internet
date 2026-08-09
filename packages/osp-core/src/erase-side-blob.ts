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
  /** CID of the side blob to delete. */
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
 * Erase an osp/0.2 side blob and append a verifiable tombstone.
 *
 * Order: delete/unpin the blob from the store, then append the tombstone so a
 * crash between steps leaves either (blob gone, no tombstone) or (tombstone
 * present). Callers may retry; delete is idempotent and a second tombstone for
 * the same blob is allowed by schema (ops should avoid duplicates).
 */
export async function eraseSideBlob(options: EraseSideBlobOptions): Promise<EraseSideBlobResult> {
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
