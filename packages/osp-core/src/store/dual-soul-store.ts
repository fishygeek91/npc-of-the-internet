import * as path from "node:path";

import { CorruptionError, StorageError } from "../errors.js";

import { FileSoulStore } from "./file-soul-store.js";
import { IpfsSoulStore } from "./ipfs-soul-store.js";

import type { AppendResult, DualSoulStoreOpenOptions, HeadInfo, SoulStore } from "./types.js";
import type { OspRecord } from "../schemas/index.js";

/**
 * Dual-write SoulStore: FileSoulStore is authoritative; IpfsSoulStore mirrors appends.
 *
 * Divergent heads at open are a fatal error. If IPFS append fails after a successful file append,
 * the error propagates — dual-write integrity is not automatically repaired.
 */
export class DualSoulStore implements SoulStore {
  private readonly fileStore: FileSoulStore;
  private readonly ipfsStore: IpfsSoulStore;
  private closed: boolean;

  private constructor(fileStore: FileSoulStore, ipfsStore: IpfsSoulStore) {
    this.fileStore = fileStore;
    this.ipfsStore = ipfsStore;
    this.closed = false;
  }

  /**
   * Open both backing stores. When both are non-empty, head CIDs must match.
   */
  static async open(
    fileDir: string,
    ipfsDir: string,
    options?: DualSoulStoreOpenOptions
  ): Promise<DualSoulStore> {
    const fileStore = await FileSoulStore.open(path.resolve(fileDir), options);
    const ipfsStore = await IpfsSoulStore.open(path.resolve(ipfsDir), options);

    await DualSoulStore.assertHeadsCompatible(await fileStore.head(), await ipfsStore.head());

    return new DualSoulStore(fileStore, ipfsStore);
  }

  /** Append to file store first, then IPFS store. */
  async append(record: OspRecord): Promise<AppendResult> {
    this.assertOpen();
    const result = await this.fileStore.append(record);
    const ipfsResult = await this.ipfsStore.append(record);
    if (result.cid !== ipfsResult.cid) {
      throw new CorruptionError(
        `dual-write CID mismatch after append: file ${result.cid} vs ipfs ${ipfsResult.cid}`
      );
    }
    return result;
  }

  /** Return head from the authoritative file store. */
  async head(): Promise<HeadInfo | null> {
    this.assertOpen();
    return this.fileStore.head();
  }

  /** Fetch a record from the authoritative file store. */
  async get(cid: string): Promise<OspRecord> {
    this.assertOpen();
    return this.fileStore.get(cid);
  }

  /** Iterate records from the authoritative file store. */
  async *iterate(): AsyncIterable<OspRecord> {
    this.assertOpen();
    yield* this.fileStore.iterate();
  }

  /** Close both backing stores. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.fileStore.close();
    await this.ipfsStore.close();
    this.closed = true;
  }

  /** Fatal when both stores are non-empty but heads differ. */
  private static async assertHeadsCompatible(
    fileHead: HeadInfo | null,
    ipfsHead: HeadInfo | null
  ): Promise<void> {
    if (fileHead === null || ipfsHead === null) {
      return;
    }

    if (fileHead.cid !== ipfsHead.cid || fileHead.seq !== ipfsHead.seq) {
      throw new CorruptionError(
        `dual-write head divergence: file ${fileHead.cid} seq ${fileHead.seq} vs ipfs ${ipfsHead.cid} seq ${ipfsHead.seq}`
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError("DualSoulStore is closed");
    }
  }
}
