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

/** Options for opening a file-backed SoulStore (v0.1). */
export type FileSoulStoreOpenOptions = {
  /** Door public keys used to verify cosigner signatures on open/get. */
  doorPublicKeys?: readonly Uint8Array[];
};

/**
 * Storage-agnostic append-only soulchain store (FileSoulStore v0.1; IPFS later).
 *
 * Implementations must preserve append-only semantics: no mutation or deletion
 * of committed records.
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
}
