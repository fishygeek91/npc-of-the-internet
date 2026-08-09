import type { OspRecord } from "../schemas/index.js";

/** CID and sequence number of the current chain head. */
export type HeadInfo = {
  cid: string;
  seq: number;
};

/** Result of a successful append to the soulchain. */
export type AppendResult = {
  cid: string;
};

/** Result of storing an osp/0.2 side blob (CID is content-derived). */
export type PutSideBlobResult = {
  cid: string;
};

/** Options for opening a file-backed SoulStore (v0.1). */
export type FileSoulStoreOpenOptions = {
  /**
   * Door public keys keyed by residency Door id (e.g. `discord:guild123`)
   * for cosigner verification on open/get/append.
   */
  doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
};

/** Options for opening an IPFS blockstore-backed SoulStore (v0.2 L1). */
export type IpfsSoulStoreOpenOptions = {
  /**
   * Door public keys keyed by residency Door id (e.g. `discord:guild123`)
   * for cosigner verification on open/get/append.
   */
  doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
  /**
   * When enabled, successful appends enqueue the record CID to `replication.jsonl`.
   * Enqueue failures never fail append.
   */
  replication?: { enabled: boolean };
  /** Injectable clock for replication `enqueued_at` metadata (defaults to ISO wall time). */
  now?: () => string;
};

/** Options for opening a dual-write SoulStore (file authoritative + IPFS mirror). */
export type DualSoulStoreOpenOptions = IpfsSoulStoreOpenOptions;

/**
 * Storage-agnostic append-only soulchain store (FileSoulStore v0.1; IPFS later).
 *
 * Implementations must preserve append-only semantics: no mutation or deletion
 * of committed records. Side blobs (osp/0.2 prose) are CID-keyed opaque bytes and
 * MAY be deleted for erasure (tombstone path).
 */
export interface SoulStore {
  /** Append a signed record to the chain and return its CID. */
  append(record: OspRecord): Promise<AppendResult>;

  /** Return the current head, or null if the chain is empty. */
  head(): Promise<HeadInfo | null>;

  /** Fetch a record by CID. */
  get(cid: string): Promise<OspRecord>;

  /** Iterate all records in chain order from genesis to head. */
  iterate(): AsyncIterable<OspRecord>;

  /**
   * Store opaque side-blob bytes (osp/0.2 memory text/journal).
   * Idempotent when the same CID already holds identical bytes.
   */
  putSideBlob(bytes: Uint8Array): Promise<PutSideBlobResult>;

  /** Fetch side-blob bytes and verify CID identity. */
  getSideBlob(cid: string): Promise<Uint8Array>;

  /**
   * Remove side-blob bytes (erasure). Missing blob is not an error.
   * Must not delete soulchain record blocks that share the CID namespace —
   * callers only pass memory text/journal blob CIDs.
   */
  deleteSideBlob(cid: string): Promise<void>;
}
