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
  /**
   * Side-blob bytes keyed by CID (osp/0.2 journal/text blobs found while loading).
   * Missing CIDs are omitted (tombstoned or unavailable).
   */
  sideBlobs?: ReadonlyMap<string, Uint8Array>;
};

type ChainFingerprint = {
  size: number;
  mtimeMs: number;
};

/** Default reuse window for an unreadable load result (see {@link ChainViewOptions.unreadableTtlMs}). */
export const DEFAULT_UNREADABLE_TTL_MS = 2_000;

export type ChainViewOptions = {
  chainDir: string;
  doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
  /**
   * How long (ms) an unreadable load result is reused while neither `chain.jsonl`
   * nor the `blobs/` directory changed. Bounds the cost of a request burst
   * against a corrupt chain; a blob restore (new directory entry) or any append
   * invalidates it immediately. Default {@link DEFAULT_UNREADABLE_TTL_MS}.
   */
  unreadableTtlMs?: number;
  /** Clock for the unreadable reuse window (tests). Defaults to `Date.now`. */
  now?: () => number;
};

type UnreadableEntry = {
  key: string;
  snapshot: ChainSnapshot;
  expiresAt: number;
};

/**
 * Cached read-only view over a soulchain directory.
 * Reloads when `chain.jsonl` size or mtime changes. Concurrent callers that
 * observe the same chain fingerprint share one in-flight load (no stampede),
 * and an unreadable result is reused briefly (see {@link ChainViewOptions}).
 */
export class ChainView {
  private readonly chainPath: string;
  private readonly blobsPath: string;
  private readonly doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined;
  private readonly unreadableTtlMs: number;
  private readonly now: () => number;
  private fingerprint: ChainFingerprint | null;
  private cachedSnapshot: ChainSnapshot | null;
  private unreadable: UnreadableEntry | null;
  private readonly inFlight: Map<string, Promise<ChainSnapshot>>;
  private loadGeneration: number;
  private storedGeneration: number;

  constructor(options: ChainViewOptions) {
    this.chainPath = path.join(options.chainDir, "chain.jsonl");
    this.blobsPath = path.join(options.chainDir, "blobs");
    this.doorPublicKeys = options.doorPublicKeys;
    this.unreadableTtlMs = options.unreadableTtlMs ?? DEFAULT_UNREADABLE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.fingerprint = null;
    this.cachedSnapshot = null;
    this.unreadable = null;
    this.inFlight = new Map();
    this.loadGeneration = 0;
    this.storedGeneration = 0;
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
      this.fingerprint = null;
      this.cachedSnapshot = null;
      this.unreadable = null;
      return {
        records: [],
        head: null,
        verified: false,
        unreadable: true,
        unreadableMessage: message
      };
    }

    if (
      this.cachedSnapshot !== null &&
      this.fingerprint !== null &&
      this.fingerprint.size === fingerprint.size &&
      this.fingerprint.mtimeMs === fingerprint.mtimeMs
    ) {
      return this.cachedSnapshot;
    }

    const key = `${fingerprint.size}:${fingerprint.mtimeMs}`;

    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }

    if (this.unreadable !== null && this.now() < this.unreadable.expiresAt) {
      const unreadableKey = await this.unreadableKey(key);
      if (unreadableKey === this.unreadable.key) {
        return this.unreadable.snapshot;
      }
    }

    // Re-check: another caller may have started the load while we awaited stat.
    const raced = this.inFlight.get(key);
    if (raced !== undefined) {
      return raced;
    }

    this.loadGeneration += 1;
    const generation = this.loadGeneration;
    const load = this.load(fingerprint, key, generation).finally(() => {
      if (this.inFlight.get(key) === load) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, load);
    return load;
  }

  /** Release cached snapshot state. */
  async close(): Promise<void> {
    this.fingerprint = null;
    this.cachedSnapshot = null;
    this.unreadable = null;
    this.inFlight.clear();
  }

  /** Unreadable-cache key: chain fingerprint plus the blobs/ directory mtime. */
  private async unreadableKey(chainKey: string): Promise<string> {
    try {
      const blobsStat = await stat(this.blobsPath);
      return `${chainKey}|${blobsStat.mtimeMs}`;
    } catch {
      return `${chainKey}|missing`;
    }
  }

  private async load(
    fingerprint: ChainFingerprint,
    key: string,
    generation: number
  ): Promise<ChainSnapshot> {
    // Taken before reading so a blob repair during the load invalidates the entry.
    const unreadableKey = await this.unreadableKey(key);
    try {
      const storeOptions =
        this.doorPublicKeys === undefined ? undefined : { doorPublicKeys: this.doorPublicKeys };
      const store = await FileSoulStore.openReadOnly(path.dirname(this.chainPath), storeOptions);
      try {
        const records: OspRecord[] = [];
        for await (const record of store.iterate()) {
          records.push(record);
        }
        // Eager load of referenced side blobs into the snapshot. Fine at Ghost
        // scale; journals are uncapped so this map grows with chain length —
        // revisit lazy/fetch-on-demand if Atlas memory becomes an issue.
        const sideBlobs = new Map<string, Uint8Array>();
        for (const record of records) {
          if (record.type !== "memory" || record.body.kind !== "shard") {
            continue;
          }
          const body = record.body;
          const cids: string[] = [];
          if ("text_cid" in body) {
            cids.push(body.text_cid);
          }
          if ("journal_cid" in body && body.journal_cid !== undefined) {
            cids.push(body.journal_cid);
          }
          for (const cid of cids) {
            if (sideBlobs.has(cid)) {
              continue;
            }
            try {
              sideBlobs.set(cid, await store.getSideBlob(cid));
            } catch {
              // Tombstoned or missing — derive paths surface erased markers.
            }
          }
        }
        const verified = store.verification().valid;
        const head = await store.head();
        return this.storeSnapshot(fingerprint, unreadableKey, generation, {
          records,
          head,
          verified,
          sideBlobs
        });
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
        return this.storeSnapshot(fingerprint, unreadableKey, generation, {
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

  private storeSnapshot(
    fingerprint: ChainFingerprint,
    unreadableKey: string,
    generation: number,
    snapshot: ChainSnapshot
  ): ChainSnapshot {
    // A load that started before a newer one finished must not clobber it.
    if (generation < this.storedGeneration) {
      return snapshot;
    }
    this.storedGeneration = generation;
    // Unreadable snapshots are only reused briefly, keyed on chain.jsonl AND the
    // blobs/ directory: blob-side CorruptionError is otherwise invisible to the
    // chain fingerprint, so a mid-restore blob repair must not stick on 503.
    if (snapshot.unreadable === true) {
      this.fingerprint = null;
      this.cachedSnapshot = null;
      this.unreadable =
        this.unreadableTtlMs > 0
          ? { key: unreadableKey, snapshot, expiresAt: this.now() + this.unreadableTtlMs }
          : null;
      return snapshot;
    }
    this.fingerprint = fingerprint;
    this.cachedSnapshot = snapshot;
    this.unreadable = null;
    return snapshot;
  }
}
