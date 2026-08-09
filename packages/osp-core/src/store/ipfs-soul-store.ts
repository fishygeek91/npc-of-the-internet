import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import * as path from "node:path";

import { FsBlockstore } from "blockstore-fs";
import { NextToLast } from "blockstore-fs/sharding";
import { CID } from "multiformats/cid";

import { canonicalize } from "../canonical.js";
import { computeCidFromCanonicalBytes, isValidCid } from "../crypto/cid.js";
import { decodePublicKey } from "../encoding/base64url.js";
import {
  ChainMismatchError,
  CorruptionError,
  SchemaError,
  StorageError,
  VerificationError
} from "../errors.js";
import { verifyRecord } from "../record.js";
import { RecordSchema, type OspRecord } from "../schemas/index.js";
import { verifyRecords } from "../verify-chain.js";

import { FileLock } from "./file-lock.js";
import { readHead, writeHeadAtomic } from "./head-file.js";
import { bytesEqual, fsyncDirectory, fsyncPath } from "./fsync.js";
import { isNodeError, nodeErrorMessage } from "./node-fs-error.js";
import { enqueueReplication } from "../replication/queue.js";
import {
  appendSeqIndex,
  readSeqIndex,
  recoverTornSeqIndex,
  type SeqIndexEntry
} from "./seq-index.js";

import type {
  AppendResult,
  HeadInfo,
  IpfsSoulStoreOpenOptions,
  PutSideBlobResult,
  SoulStore
} from "./types.js";

const BLOCKS_DIR = "blocks";
const SEQ_INDEX_FILE = "seq-index.jsonl";
const LOCK_FILE = "LOCK";

/**
 * Resolve the on-disk path for a CID under a blocks directory using the same
 * NextToLast sharding strategy FsBlockstore defaults to.
 */
export function resolveBlockPath(
  blocksPath: string,
  cid: string,
  shard = new NextToLast()
): string {
  const { dir, file } = shard.encode(CID.parse(cid));
  return path.join(blocksPath, dir, file);
}

/** Collect all chunks from a blockstore get() async generator into one Uint8Array. */
async function collectBytes(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of gen) {
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * IPFS blockstore-backed append-only soulchain store (local L1, no network).
 */
export class IpfsSoulStore implements SoulStore {
  private readonly dir: string;
  private readonly blocksPath: string;
  private readonly seqIndexPath: string;
  private readonly blockstore: FsBlockstore;
  private readonly shard: NextToLast;
  private readonly appendLock: FileLock;
  private readonly doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined;
  private readonly replicationEnabled: boolean;
  private readonly now: () => string;
  private readonly readOnly: boolean;
  private headInfo: HeadInfo | null;
  private soulPublicKey: Uint8Array | null;
  private closed: boolean;

  private constructor(
    dir: string,
    blockstore: FsBlockstore,
    shard: NextToLast,
    doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined,
    head: HeadInfo | null,
    soulPublicKey: Uint8Array | null,
    readOnly = false,
    replicationEnabled = false,
    now: () => string = () => new Date().toISOString()
  ) {
    this.dir = dir;
    this.blocksPath = path.join(dir, BLOCKS_DIR);
    this.seqIndexPath = path.join(dir, SEQ_INDEX_FILE);
    this.blockstore = blockstore;
    this.shard = shard;
    this.appendLock = new FileLock(path.join(dir, LOCK_FILE));
    this.doorPublicKeys = doorPublicKeys;
    this.replicationEnabled = replicationEnabled;
    this.now = now;
    this.readOnly = readOnly;
    this.headInfo = head;
    this.soulPublicKey = soulPublicKey;
    this.closed = false;
  }

  /** Create FsBlockstore bound to the same NextToLast shard used for durable fsync paths. */
  private static createBlockstore(
    absoluteDir: string,
    init?: { createIfMissing?: boolean }
  ): { blockstore: FsBlockstore; shard: NextToLast } {
    const shard = new NextToLast();
    const blocksPath = path.join(absoluteDir, BLOCKS_DIR);
    const blockstore = new FsBlockstore(blocksPath, {
      shardingStrategy: shard,
      ...(init?.createIfMissing === undefined ? {} : { createIfMissing: init.createIfMissing })
    });
    return { blockstore, shard };
  }

  /** Open a soulchain directory. Never auto-truncates torn writes; use {@link openWithRecovery} instead. */
  static async open(dir: string, options?: IpfsSoulStoreOpenOptions): Promise<IpfsSoulStore> {
    const absoluteDir = path.resolve(dir);
    const { blockstore, shard } = IpfsSoulStore.createBlockstore(absoluteDir);
    await blockstore.open();

    const store = IpfsSoulStore.createInstance(absoluteDir, blockstore, shard, options, false);
    await store.ensureLayout();
    await store.loadChain();
    return store;
  }

  /**
   * Open after recovering from torn writes or stale locks.
   *
   * Clears stale LOCK, truncates torn seq-index tails, and advances HEAD when blocks+seq-index
   * are ahead of a stale/missing HEAD (block-written / HEAD-not-updated crash window).
   */
  static async openWithRecovery(
    dir: string,
    options?: IpfsSoulStoreOpenOptions
  ): Promise<{ store: IpfsSoulStore; truncatedBytes: number }> {
    const absoluteDir = path.resolve(dir);
    const { blockstore, shard } = IpfsSoulStore.createBlockstore(absoluteDir);
    await blockstore.open();

    const store = IpfsSoulStore.createInstance(absoluteDir, blockstore, shard, options, false);
    await store.ensureLayout();

    await store.appendLock.clearStale();

    const truncatedBytes = await recoverTornSeqIndex(store.seqIndexPath);
    await store.reconcileHeadWithSeqIndex();
    await store.loadChain();

    return { store, truncatedBytes };
  }

  /**
   * Open an existing soulchain directory for read-only access.
   *
   * Does not create directories or lock files. Throws CorruptionError on invalid state.
   */
  static async openReadOnly(
    dir: string,
    options?: IpfsSoulStoreOpenOptions
  ): Promise<IpfsSoulStore> {
    const absoluteDir = path.resolve(dir);

    if (!existsSync(absoluteDir)) {
      throw new StorageError(`soulchain directory does not exist: ${absoluteDir}`);
    }

    const blocksPath = path.join(absoluteDir, BLOCKS_DIR);
    if (!existsSync(blocksPath)) {
      throw new StorageError(`blocks directory does not exist: ${blocksPath}`);
    }

    const { blockstore, shard } = IpfsSoulStore.createBlockstore(absoluteDir, {
      createIfMissing: false
    });
    await blockstore.open();

    const store = IpfsSoulStore.createInstance(absoluteDir, blockstore, shard, options, true);
    await store.loadChain();
    return store;
  }

  /** Build a store instance from open options (shared by open paths). */
  private static createInstance(
    absoluteDir: string,
    blockstore: FsBlockstore,
    shard: NextToLast,
    options: IpfsSoulStoreOpenOptions | undefined,
    readOnly: boolean
  ): IpfsSoulStore {
    const replicationEnabled = options?.replication?.enabled === true;
    const now = options?.now ?? (() => new Date().toISOString());
    return new IpfsSoulStore(
      absoluteDir,
      blockstore,
      shard,
      options?.doorPublicKeys,
      null,
      null,
      readOnly,
      replicationEnabled,
      now
    );
  }

  /** Append a signed record to the chain and return its CID. */
  async append(record: OspRecord): Promise<AppendResult> {
    this.assertOpen();

    if (this.readOnly) {
      throw new StorageError("IpfsSoulStore is read-only");
    }

    const parsed = RecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new SchemaError(parsed.error.message);
    }
    const validatedRecord = parsed.data;

    this.appendLock.acquire();

    try {
      await this.refreshHeadFromDisk();

      if (this.headInfo === null) {
        if (validatedRecord.seq !== 0 || validatedRecord.prev !== null) {
          throw new ChainMismatchError("first append requires seq 0 and prev null");
        }
        if (validatedRecord.type !== "genesis") {
          throw new ChainMismatchError("first append requires type genesis");
        }
      } else if (
        validatedRecord.prev !== this.headInfo.cid ||
        validatedRecord.seq !== this.headInfo.seq + 1
      ) {
        throw new ChainMismatchError(
          `append prev/seq mismatch: expected prev ${this.headInfo.cid} seq ${this.headInfo.seq + 1}`
        );
      }

      let soulPublicKey: Uint8Array;
      if (validatedRecord.type === "genesis" && validatedRecord.seq === 0) {
        soulPublicKey = decodePublicKey(validatedRecord.body.soul_pubkey);
      } else if (this.soulPublicKey === null) {
        throw new StorageError("soul public key missing for non-empty store");
      } else {
        soulPublicKey = this.soulPublicKey;
      }

      await verifyRecord(validatedRecord, {
        soulPublicKey,
        ...(this.doorPublicKeys !== undefined ? { doorPublicKeys: this.doorPublicKeys } : {})
      });

      const bytes = canonicalize(validatedRecord);
      const cid = await computeCidFromCanonicalBytes(bytes);
      await this.putBlockIdempotent(cid, bytes);

      await appendSeqIndex(this.seqIndexPath, { seq: validatedRecord.seq, cid });
      await writeHeadAtomic(this.dir, { cid, seq: validatedRecord.seq });

      this.headInfo = { cid, seq: validatedRecord.seq };

      if (validatedRecord.seq === 0 && validatedRecord.type === "genesis") {
        this.soulPublicKey = decodePublicKey(validatedRecord.body.soul_pubkey);
      }

      if (this.replicationEnabled) {
        try {
          await enqueueReplication(this.dir, {
            cid,
            kind: "record",
            enqueued_at: this.now()
          });
        } catch {
          // Replication enqueue must never fail append (spec §5.1).
        }
      }

      return { cid };
    } finally {
      this.appendLock.release();
    }
  }

  /** Return the current head, or null if the chain is empty. */
  async head(): Promise<HeadInfo | null> {
    this.assertOpen();
    if (this.headInfo === null) {
      return null;
    }
    return { cid: this.headInfo.cid, seq: this.headInfo.seq };
  }

  /**
   * Store opaque side-blob bytes (osp/0.2 memory text/journal).
   * Shares the record blockstore; CID-keyed opaque bytes.
   */
  async putSideBlob(bytes: Uint8Array): Promise<PutSideBlobResult> {
    this.assertOpen();
    if (this.readOnly) {
      throw new StorageError("IpfsSoulStore is read-only");
    }
    const cid = await computeCidFromCanonicalBytes(bytes);
    await this.putBlockIdempotent(cid, bytes);
    return { cid };
  }

  /** Fetch side-blob bytes and verify CID identity. */
  async getSideBlob(cid: string): Promise<Uint8Array> {
    this.assertOpen();
    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }
    const parsedCid = CID.parse(cid);
    if (!(await this.blockstore.has(parsedCid))) {
      throw new StorageError(`side blob not found for CID ${cid}`);
    }
    return this.readBlockVerified(cid);
  }

  /** Remove side-blob bytes (idempotent erasure). */
  async deleteSideBlob(cid: string): Promise<void> {
    this.assertOpen();
    if (this.readOnly) {
      throw new StorageError("IpfsSoulStore is read-only");
    }
    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }
    const parsedCid = CID.parse(cid);
    if (!(await this.blockstore.has(parsedCid))) {
      return;
    }
    await this.blockstore.delete(parsedCid);
  }

  /** Fetch a record by CID. */
  async get(cid: string): Promise<OspRecord> {
    this.assertOpen();

    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }

    const canonicalBytes = await this.readBlockVerified(cid);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(canonicalBytes));
    } catch (error) {
      throw new CorruptionError(`invalid JSON in block ${cid}: ${nodeErrorMessage(error)}`);
    }

    const schemaResult = RecordSchema.safeParse(parsed);
    if (!schemaResult.success) {
      throw new SchemaError(schemaResult.error.message);
    }

    if (this.soulPublicKey !== null) {
      const verifyOptions: {
        soulPublicKey: Uint8Array;
        doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
        expectedCid: string;
      } = {
        soulPublicKey: this.soulPublicKey,
        expectedCid: cid
      };
      if (this.doorPublicKeys !== undefined) {
        verifyOptions.doorPublicKeys = this.doorPublicKeys;
      }

      try {
        await verifyRecord(schemaResult.data, verifyOptions);
      } catch (error) {
        if (error instanceof VerificationError || error instanceof SchemaError) {
          throw new CorruptionError(`record verification failed for ${cid}: ${error.message}`);
        }
        throw error;
      }
    }

    return schemaResult.data;
  }

  /** Iterate all records in chain order from genesis to head. */
  async *iterate() {
    this.assertOpen();

    const entries = await this.readSeqIndexSafe();
    for (const entry of entries) {
      const record = await this.get(entry.cid);
      if (record.seq !== entry.seq) {
        throw new CorruptionError(
          `seq-index seq ${entry.seq} does not match record seq ${record.seq} for CID ${entry.cid}`
        );
      }
      yield record;
    }
  }

  /** Release resources held by this store. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.appendLock.release();
    await this.blockstore.close();
    this.closed = true;
  }

  /** Ensure directory layout exists under the store root. */
  private async ensureLayout(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.blocksPath, { recursive: true });

    if (!existsSync(this.seqIndexPath)) {
      const fd = openSync(this.seqIndexPath, "w");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await fsyncDirectory(this.dir);
    }
  }

  /**
   * Re-read HEAD from disk under the append lock.
   */
  private async refreshHeadFromDisk(): Promise<void> {
    const head = await readHead(this.dir);
    this.headInfo = head;

    if (head === null) {
      return;
    }

    if (this.soulPublicKey === null) {
      const entries = await this.readSeqIndexSafe();
      const genesisEntry = entries[0];
      if (genesisEntry !== undefined) {
        const genesisRecord = await this.get(genesisEntry.cid);
        if (genesisRecord.type === "genesis") {
          this.soulPublicKey = decodePublicKey(genesisRecord.body.soul_pubkey);
        }
      }
    }
  }

  /**
   * Advance HEAD when seq-index has entries beyond HEAD (block+index written, HEAD stale).
   */
  private async reconcileHeadWithSeqIndex(): Promise<void> {
    const head = await readHead(this.dir);
    const entries = await readSeqIndex(this.seqIndexPath).catch((error: unknown) => {
      if (error instanceof CorruptionError) {
        return null;
      }
      throw error;
    });

    if (entries === null) {
      return;
    }

    if (entries.length === 0) {
      return;
    }

    const expectedCount = head === null ? 0 : head.seq + 1;

    if (entries.length < expectedCount) {
      throw new CorruptionError(
        `HEAD ahead of seq-index: head seq ${head?.seq ?? "null"} but index has ${entries.length} entries`
      );
    }

    if (entries.length === expectedCount) {
      return;
    }

    const extraEntries = entries.slice(expectedCount);
    for (const entry of extraEntries) {
      await this.readBlockVerified(entry.cid);
    }

    const lastEntry = entries[entries.length - 1];
    if (lastEntry === undefined) {
      return;
    }

    if (lastEntry.seq !== entries.length - 1) {
      throw new CorruptionError(
        `seq-index seq ${lastEntry.seq} does not match position ${entries.length - 1}`
      );
    }

    await writeHeadAtomic(this.dir, { cid: lastEntry.cid, seq: lastEntry.seq });
  }

  /** Read and validate the on-disk chain via seq-index + blocks. */
  private async loadChain(): Promise<void> {
    const head = await readHead(this.dir);
    const entries = await this.readSeqIndexForLoad();

    if (head === null && entries.length === 0) {
      this.headInfo = null;
      this.soulPublicKey = null;
      return;
    }

    if (head === null && entries.length > 0) {
      throw new CorruptionError("seq-index has entries but HEAD is missing");
    }

    if (head !== null && entries.length !== head.seq + 1) {
      throw new CorruptionError(
        `HEAD/seq-index mismatch: head seq ${head.seq} but index has ${entries.length} entries`
      );
    }

    if (entries.length === 0) {
      this.headInfo = null;
      this.soulPublicKey = null;
      return;
    }

    const records = await this.loadRecordsFromIndex(entries);

    const verifyOptions: { doorPublicKeys?: Readonly<Record<string, Uint8Array>> } = {};
    if (this.doorPublicKeys !== undefined) {
      verifyOptions.doorPublicKeys = this.doorPublicKeys;
    }

    const verifyResult = await verifyRecords(records, verifyOptions);
    if (!verifyResult.valid) {
      const firstFailure = verifyResult.failures[0];
      if (firstFailure !== undefined) {
        const cidPart = firstFailure.cid === undefined ? "" : ` (cid ${firstFailure.cid})`;
        throw new CorruptionError(
          `chain verification failed: ${firstFailure.rule} at seq ${firstFailure.seq}${cidPart}: ${firstFailure.message}`,
          { failures: verifyResult.failures }
        );
      }
      throw new CorruptionError("chain verification failed", { failures: verifyResult.failures });
    }

    this.headInfo = verifyResult.head;
    this.setSoulPublicKeyFromRecords(records);
  }

  /** Load raw record JSON from seq-index entries, verifying block bytes and canonical form. */
  private async loadRecordsFromIndex(entries: SeqIndexEntry[]): Promise<unknown[]> {
    const records: unknown[] = [];

    for (const entry of entries) {
      const canonicalBytes = await this.readBlockVerified(entry.cid);

      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(canonicalBytes));
      } catch (error) {
        throw new CorruptionError(
          `invalid JSON in block for CID ${entry.cid}: ${nodeErrorMessage(error)}`
        );
      }

      const reCanonical = canonicalize(parsed);
      if (!bytesEqual(canonicalBytes, reCanonical)) {
        throw new CorruptionError(`non-canonical block bytes for CID ${entry.cid}`);
      }

      const schemaResult = RecordSchema.safeParse(parsed);
      if (!schemaResult.success) {
        throw new CorruptionError(
          `invalid record at seq ${entry.seq}: ${schemaResult.error.message}`
        );
      }

      if (schemaResult.data.seq !== entry.seq) {
        throw new CorruptionError(
          `seq-index seq ${entry.seq} does not match record seq ${schemaResult.data.seq} for CID ${entry.cid}`
        );
      }

      records.push(parsed);
    }

    return records;
  }

  /** Read seq-index; create empty file on first open when writable. */
  private async readSeqIndexForLoad(): Promise<SeqIndexEntry[]> {
    if (!existsSync(this.seqIndexPath)) {
      if (this.readOnly) {
        return [];
      }
      const fd = openSync(this.seqIndexPath, "w");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await fsyncDirectory(this.dir);
      return [];
    }

    const indexStat = await stat(this.seqIndexPath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });

    if (indexStat === null || indexStat.size === 0) {
      return [];
    }

    return readSeqIndex(this.seqIndexPath);
  }

  /** Read seq-index for iterate/refresh; throws on torn tail. */
  private async readSeqIndexSafe(): Promise<SeqIndexEntry[]> {
    if (!existsSync(this.seqIndexPath)) {
      return [];
    }

    const indexStat = await stat(this.seqIndexPath);
    if (indexStat.size === 0) {
      return [];
    }

    return readSeqIndex(this.seqIndexPath);
  }

  /** Idempotent block put with byte-identity check on collision and durable fsync. */
  private async putBlockIdempotent(cid: string, bytes: Uint8Array): Promise<void> {
    const parsedCid = CID.parse(cid);

    if (await this.blockstore.has(parsedCid)) {
      const existing = await collectBytes(this.blockstore.get(parsedCid));
      if (!bytesEqual(existing, bytes)) {
        throw new CorruptionError(`block already exists for CID ${cid} with different bytes`);
      }
      return;
    }

    await this.blockstore.put(parsedCid, bytes);

    // FsBlockstore/steno does temp+rename with no fsync. Spec §3.2 requires the block
    // durable before seq-index/HEAD; sync the sharded .data file and both directories.
    const blockPath = resolveBlockPath(this.blocksPath, cid, this.shard);
    await fsyncPath(blockPath);
    await fsyncDirectory(path.dirname(blockPath));
    await fsyncDirectory(this.blocksPath);
  }

  /** Read block bytes and verify CID identity. */
  private async readBlockVerified(cid: string): Promise<Uint8Array> {
    const parsedCid = CID.parse(cid);

    if (!(await this.blockstore.has(parsedCid))) {
      throw new CorruptionError(`missing block for CID ${cid}`);
    }

    const bytes = await collectBytes(this.blockstore.get(parsedCid));
    const computedCid = await computeCidFromCanonicalBytes(bytes);
    if (computedCid !== cid) {
      throw new CorruptionError(`block CID mismatch for ${cid}: computed ${computedCid}`);
    }

    return bytes;
  }

  /** Extract soul public key from genesis when present at seq 0. */
  private setSoulPublicKeyFromRecords(records: unknown[]): void {
    const firstParsed = RecordSchema.safeParse(records[0]);
    if (firstParsed.success && firstParsed.data.type === "genesis") {
      this.soulPublicKey = decodePublicKey(firstParsed.data.body.soul_pubkey);
    } else {
      this.soulPublicKey = null;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError("IpfsSoulStore is closed");
    }
  }
}
