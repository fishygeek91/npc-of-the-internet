import {
  StorageError,
  contentAddressSideBlob,
  encodeJournalBlob,
  encodeShardTextBlob,
  type SoulStore
} from "@npc/osp-core";

/** Result of writing a shard/candidate text side blob. */
export type StoredTextBlob = {
  text_cid: string;
  text_hash: string;
};

/** Result of writing a journal side blob. */
export type StoredJournalBlob = {
  journal_cid: string;
  journal_hash: string;
};

/**
 * Encode shard/candidate prose, store side-blob bytes, return CID+hash refs.
 */
export async function storeShardTextBlob(store: SoulStore, text: string): Promise<StoredTextBlob> {
  const bytes = encodeShardTextBlob(text);
  const { cid, hash } = await contentAddressSideBlob(bytes);
  const put = await store.putSideBlob(bytes);
  if (put.cid !== cid) {
    throw new StorageError(`side-blob CID mismatch: put ${put.cid} vs content-addressed ${cid}`);
  }
  return { text_cid: cid, text_hash: hash };
}

/**
 * Encode journal markdown, store side-blob bytes, return CID+hash refs.
 */
export async function storeJournalBlob(
  store: SoulStore,
  markdown: string
): Promise<StoredJournalBlob> {
  const bytes = encodeJournalBlob(markdown);
  const { cid, hash } = await contentAddressSideBlob(bytes);
  const put = await store.putSideBlob(bytes);
  if (put.cid !== cid) {
    throw new StorageError(`side-blob CID mismatch: put ${put.cid} vs content-addressed ${cid}`);
  }
  return { journal_cid: cid, journal_hash: hash };
}
