import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { CorruptionError, StorageError } from "../errors.js";

import { FileSoulStore } from "./file-soul-store.js";
import { IpfsSoulStore } from "./ipfs-soul-store.js";

import type {
  AppendResult,
  DualSoulStoreOpenOptions,
  HeadInfo,
  PutSideBlobResult,
  SoulStore
} from "./types.js";
import type { OspRecord } from "../schemas/index.js";

/**
 * Dual-write SoulStore: FileSoulStore is authoritative; IpfsSoulStore mirrors appends.
 *
 * At open, an empty or lagging mirror is backfilled from the authoritative file store
 * (genesis-seeded volumes and crash-torn dual writes both self-heal). Divergent heads at
 * the same seq remain a fatal error, as does a mirror ahead of the file store. If an IPFS
 * append fails after a successful file append at runtime, the error still propagates; the
 * next open repairs the lag.
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

    await DualSoulStore.backfillMirror(path.resolve(fileDir), fileStore, ipfsStore);
    await DualSoulStore.assertHeadsCompatible(await fileStore.head(), await ipfsStore.head());

    return new DualSoulStore(fileStore, ipfsStore);
  }

  /**
   * Open both stores after recovering torn writes on each backing directory.
   *
   * Returns combined truncated byte count from file and IPFS recovery.
   */
  static async openWithRecovery(
    fileDir: string,
    ipfsDir: string,
    options?: DualSoulStoreOpenOptions
  ): Promise<{ store: DualSoulStore; truncatedBytes: number }> {
    const { store: fileStore, truncatedBytes: fileTruncated } =
      await FileSoulStore.openWithRecovery(path.resolve(fileDir), options);
    const { store: ipfsStore, truncatedBytes: ipfsTruncated } =
      await IpfsSoulStore.openWithRecovery(path.resolve(ipfsDir), options);

    await DualSoulStore.backfillMirror(path.resolve(fileDir), fileStore, ipfsStore);
    await DualSoulStore.assertHeadsCompatible(await fileStore.head(), await ipfsStore.head());

    return {
      store: new DualSoulStore(fileStore, ipfsStore),
      truncatedBytes: fileTruncated + ipfsTruncated
    };
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

  /** Dual-write side blob: file first, then IPFS mirror. */
  async putSideBlob(bytes: Uint8Array): Promise<PutSideBlobResult> {
    this.assertOpen();
    const result = await this.fileStore.putSideBlob(bytes);
    const ipfsResult = await this.ipfsStore.putSideBlob(bytes);
    if (result.cid !== ipfsResult.cid) {
      throw new CorruptionError(
        `dual-write side-blob CID mismatch: file ${result.cid} vs ipfs ${ipfsResult.cid}`
      );
    }
    return result;
  }

  /** Fetch side blob from the authoritative file store. */
  async getSideBlob(cid: string): Promise<Uint8Array> {
    this.assertOpen();
    return this.fileStore.getSideBlob(cid);
  }

  /** Delete side blob from both stores (erasure). */
  async deleteSideBlob(cid: string): Promise<void> {
    this.assertOpen();
    await this.fileStore.deleteSideBlob(cid);
    await this.ipfsStore.deleteSideBlob(cid);
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

  /**
   * Catch the IPFS mirror up to the authoritative file store.
   *
   * Covers two launch/recovery cases with no manual intervention:
   * - Genesis-seeded file volume with an empty mirror (LAUNCH.md §2 seeds only
   *   `chain.jsonl` + `blobs/`): the mirror is rebuilt record-by-record.
   * - Mirror behind after a crash between the file append and the IPFS append:
   *   the missing suffix is re-appended.
   *
   * A mirror *ahead* of the file store is a fatal inversion of authority.
   * Divergence (same seq, different head) is left to assertHeadsCompatible /
   * the append prev-check, which fails with ChainMismatchError as before.
   * Side blobs are mirrored best-effort by content (record blocks re-derive the
   * same CIDs, so re-putting them is an idempotent no-op).
   */
  private static async backfillMirror(
    fileDir: string,
    fileStore: FileSoulStore,
    ipfsStore: IpfsSoulStore
  ): Promise<void> {
    const fileHead = await fileStore.head();
    if (fileHead === null) {
      return;
    }

    const ipfsHead = await ipfsStore.head();
    if (ipfsHead !== null && ipfsHead.seq > fileHead.seq) {
      throw new CorruptionError(
        `dual-write mirror ahead of authoritative store: ipfs seq ${ipfsHead.seq} vs file seq ${fileHead.seq}`
      );
    }
    if (ipfsHead !== null && ipfsHead.seq === fileHead.seq) {
      return;
    }

    const resumeAfterSeq = ipfsHead === null ? -1 : ipfsHead.seq;
    for await (const record of fileStore.iterate()) {
      if (record.seq <= resumeAfterSeq) {
        continue;
      }
      await ipfsStore.append(record);
    }

    // Mirror blob bytes (records + side blobs, both CID-addressed) so the
    // mirror can serve reads and CAR export without the file store.
    let blobNames: string[];
    try {
      blobNames = await readdir(path.join(fileDir, "blobs"));
    } catch {
      return;
    }
    for (const name of blobNames) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(path.join(fileDir, "blobs", name)));
      } catch {
        continue;
      }
      await ipfsStore.putSideBlob(bytes);
    }
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
