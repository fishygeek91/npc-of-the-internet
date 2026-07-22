import { stat } from "node:fs/promises";
import * as path from "node:path";

import {
  CorruptionError,
  FileSoulStore,
  SchemaError,
  StorageError,
  type HeadInfo,
  type OspRecord
} from "@npc/osp-core";

/** Immutable snapshot of the soulchain at a point in time. */
export type ChainSnapshot = {
  records: readonly OspRecord[];
  head: HeadInfo | null;
  verified: boolean;
  /** True when structural read failed — routes should return 503. */
  unreadable?: boolean;
  unreadableMessage?: string;
};

type ChainFingerprint = {
  size: number;
  mtimeMs: number;
};

export type ChainViewOptions = {
  chainDir: string;
  doorPublicKeys?: readonly Uint8Array[];
};

/**
 * Cached read-only view over a soulchain directory.
 * Reloads when `chain.jsonl` size or mtime changes.
 */
export class ChainView {
  private readonly chainPath: string;
  private readonly doorPublicKeys: readonly Uint8Array[] | undefined;
  private fingerprint: ChainFingerprint | null;
  private cachedSnapshot: ChainSnapshot | null;

  constructor(options: ChainViewOptions) {
    this.chainPath = path.join(options.chainDir, "chain.jsonl");
    this.doorPublicKeys = options.doorPublicKeys;
    this.fingerprint = null;
    this.cachedSnapshot = null;
  }

  /**
   * Refresh the snapshot when the chain file changed; otherwise return the cache.
   */
  async snapshot(): Promise<ChainSnapshot> {
    let fingerprint: ChainFingerprint;
    try {
      const fileStat = await stat(this.chainPath);
      fingerprint = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.storeSnapshot(null, {
        records: [],
        head: null,
        verified: false,
        unreadable: true,
        unreadableMessage: message
      });
    }

    if (
      this.cachedSnapshot !== null &&
      this.fingerprint !== null &&
      this.fingerprint.size === fingerprint.size &&
      this.fingerprint.mtimeMs === fingerprint.mtimeMs
    ) {
      return this.cachedSnapshot;
    }

    try {
      const storeOptions =
        this.doorPublicKeys === undefined ? undefined : { doorPublicKeys: this.doorPublicKeys };
      const store = await FileSoulStore.openReadOnly(path.dirname(this.chainPath), storeOptions);
      try {
        const records: OspRecord[] = [];
        for await (const record of store.iterate()) {
          records.push(record);
        }
        const verified = store.verification().valid;
        const head = await store.head();
        return this.storeSnapshot(fingerprint, { records, head, verified });
      } finally {
        await store.close();
      }
    } catch (error) {
      // SchemaError: mid-chain shape skew (e.g. newer writer) — surface 503, do not 500.
      if (
        error instanceof CorruptionError ||
        error instanceof StorageError ||
        error instanceof SchemaError
      ) {
        return this.storeSnapshot(fingerprint, {
          records: [],
          head: null,
          verified: false,
          unreadable: true,
          unreadableMessage: error.message
        });
      }
      throw error;
    }
  }

  /** Release cached snapshot state. */
  async close(): Promise<void> {
    this.fingerprint = null;
    this.cachedSnapshot = null;
  }

  private storeSnapshot(
    fingerprint: ChainFingerprint | null,
    snapshot: ChainSnapshot
  ): ChainSnapshot {
    this.fingerprint = fingerprint;
    this.cachedSnapshot = snapshot;
    return snapshot;
  }
}
