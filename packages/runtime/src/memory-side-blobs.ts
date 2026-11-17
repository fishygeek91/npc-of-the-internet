import {
  StorageError,
  contentAddressSideBlob,
  encodeJournalBlob,
  encodeShardTextBlob,
  type SoulStore
} from "@npc/osp-core";

/**
 * A memory side blob that is content-addressed but **not yet stored**. Depart addresses
 * prose before asking the Door to witness it and stores it only once witnessed, so
 * declined prose never reaches the store.
 */
export type AddressedBlob = {
  bytes: Uint8Array;
  cid: string;
  hash: string;
};

/** Encode shard text (≤ 500 code points) and compute its side-blob CID + hash. */
export async function addressShardTextBlob(text: string): Promise<AddressedBlob> {
  const bytes = encodeShardTextBlob(text);
  return { bytes, ...(await contentAddressSideBlob(bytes)) };
}

/** Encode journal markdown and compute its side-blob CID + hash. */
export async function addressJournalBlob(markdown: string): Promise<AddressedBlob> {
  const bytes = encodeJournalBlob(markdown);
  return { bytes, ...(await contentAddressSideBlob(bytes)) };
}

/** Store an addressed side blob; throws when the store derives a different CID. */
export async function putAddressedBlob(store: SoulStore, blob: AddressedBlob): Promise<void> {
  const put = await store.putSideBlob(blob.bytes);
  if (put.cid !== blob.cid) {
    throw new StorageError(
      `side-blob CID mismatch: put ${put.cid} vs content-addressed ${blob.cid}`
    );
  }
}
