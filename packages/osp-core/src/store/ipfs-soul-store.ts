import { closeSync, existsSync, fsyncSync, openSync, type Dirent } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
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
  EncodingError,
  SchemaError,
  StorageError,
  VerificationError
} from "../errors.js";
import { verifyRecord } from "../record.js";
import { RecordSchema, type OspRecord } from "../schemas/index.js";
import {
  appendRejectionError,
  ChainVerifier,
  chainVerificationCorruption,
  verifyRecordsWithState
} from "../verify-chain.js";

import { FileLock } from "./file-lock.js";
import { readHead, writeHeadAtomic } from "./head-file.js";
import { assertBytesHashToCid } from "./blob-dir.js";
import {
  bytesEqual,
  fsyncDirectory,
  fsyncPath,
  isAtomicTempName,
  removeStaleTempFiles,
  writeFileAtomic
} from "./fsync.js";
import { isNodeError, nodeErrorMessage } from "./node-fs-error.js";
import { enqueueReplication, recoverReplicationJournal } from "../replication/queue.js";
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
/** Block temp files: our `.tmp-*` atomic writes and steno's `.<name>.tmp` (blockstore-fs). */
function isBlockTempName(name: string): boolean {
  return isAtomicTempName(name) || (name.startsWith(".") && name.endsWith(".tmp"));
}

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
  /** Incremental chain-rule state for the on-disk prefix (append-time verification). */
  private chainVerifier: ChainVerifier;
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
    this.chainVerifier = new ChainVerifier(this.verifyOptions());
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
   * Clears stale LOCK, truncates torn seq-index and `replication.jsonl` tails, and — once the
   * seq-index chain has fully verified — advances HEAD when blocks+seq-index are ahead of a
   * stale/missing HEAD (block-written / HEAD-not-updated crash window). A HEAD that is not a
   * prefix of the verified seq-index chain is corruption, never silently rewritten.
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

    const truncatedSeqIndex = await recoverTornSeqIndex(store.seqIndexPath);
    const truncatedReplication = await recoverReplicationJournal(absoluteDir);
    // HEAD is repaired only AFTER the seq-index chain fully verifies (never before).
    await store.loadChain({ repairHead: true });

    return { store, truncatedBytes: truncatedSeqIndex + truncatedReplication };
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

      if (validatedRecord.type !== "genesis" && this.soulPublicKey === null) {
        throw new StorageError("soul public key missing for non-empty store");
      }

      // Another store instance may have appended since our load: re-walk the on-disk chain so
      // the incremental verifier describes exactly the prefix this record extends.
      if (this.chainVerifier.head?.cid !== this.headInfo?.cid) {
        await this.rebuildChainVerifier();
      }

      // Full chain rules (records.md Verification) for the candidate BEFORE any durable write,
      // so an append can never persist a record that makes the store unopenable.
      const step = await this.chainVerifier.evaluate(validatedRecord);
      if (step.recordError !== undefined) {
        throw step.recordError;
      }
      if (step.failures.length > 0) {
        throw appendRejectionError(step.failures);
      }

      const bytes = canonicalize(validatedRecord);
      const cid = await computeCidFromCanonicalBytes(bytes);
      await this.putBlockIdempotent(cid, bytes);

      await appendSeqIndex(this.seqIndexPath, { seq: validatedRecord.seq, cid });
      await writeHeadAtomic(this.dir, { cid, seq: validatedRecord.seq });

      this.headInfo = { cid, seq: validatedRecord.seq };
      step.commit();

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
    // FsBlockstore unlinks without fsync; make the erasure durable like BlobDir.delete.
    const blockPath = resolveBlockPath(this.blocksPath, cid, this.shard);
    await fsyncDirectory(path.dirname(blockPath));
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

  /**
   * Ensure directory layout exists under the store root (writable opens only), and
   * garbage-collect orphaned block temp files (see {@link removeStaleBlockTempFiles}).
   */
  private async ensureLayout(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.blocksPath, { recursive: true });
    await this.removeStaleBlockTempFiles();

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
   * Remove orphaned block temp files older than `STALE_TEMP_MAX_AGE_MS` (1 h) from the
   * blockstore root and its shard directories: our own `.tmp-*` atomic replacements and
   * blockstore-fs/steno's `.<name>.tmp` temp files (crash between temp write and rename).
   */
  private async removeStaleBlockTempFiles(): Promise<void> {
    await removeStaleTempFiles(this.blocksPath, isBlockTempName);
    let entries: Dirent[];
    try {
      entries = await readdir(this.blocksPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await removeStaleTempFiles(path.join(this.blocksPath, entry.name), isBlockTempName);
      }
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
   * Read and validate the on-disk chain via seq-index + blocks, then cross-check HEAD.
   *
   * Strict (default): HEAD must name exactly the last seq-index entry (same seq **and** CID).
   * `repairHead` (openWithRecovery): HEAD may lag the seq-index (crash after index append,
   * before HEAD replace) or be missing; after the whole indexed chain verifies, HEAD is
   * atomically advanced to the verified head. HEAD ahead of, or diverging from, the index is
   * corruption in both modes.
   */
  private async loadChain(options?: { repairHead?: boolean }): Promise<void> {
    const repairHead = options?.repairHead === true;
    const head = await readHead(this.dir);
    const entries = await this.readSeqIndexForLoad();

    if (head === null && entries.length === 0) {
      this.headInfo = null;
      this.soulPublicKey = null;
      this.chainVerifier = new ChainVerifier(this.verifyOptions());
      return;
    }

    if (!repairHead) {
      if (head === null) {
        throw new CorruptionError("seq-index has entries but HEAD is missing");
      }
      if (entries.length !== head.seq + 1) {
        throw new CorruptionError(
          `HEAD/seq-index mismatch: head seq ${head.seq} but index has ${entries.length} entries`
        );
      }
    } else if (head !== null && entries.length < head.seq + 1) {
      throw new CorruptionError(
        `HEAD ahead of seq-index: head seq ${head.seq} but index has ${entries.length} entries`
      );
    }

    if (head !== null) {
      const entryAtHead = entries[head.seq];
      if (entryAtHead === undefined || entryAtHead.cid !== head.cid) {
        throw new CorruptionError(
          `HEAD ${head.cid} seq ${head.seq} does not match seq-index entry ${entryAtHead?.cid ?? "(missing)"}`
        );
      }
    }

    const records = await this.loadRecordsFromIndex(entries);
    const { result: verifyResult, verifier } = await verifyRecordsWithState(
      records,
      this.verifyOptions()
    );
    if (!verifyResult.valid) {
      throw chainVerificationCorruption(verifyResult.failures);
    }

    const verifiedHead = verifyResult.head;
    if (verifiedHead === null) {
      throw new CorruptionError("seq-index chain verified empty but entries are present");
    }

    if (head === null || head.cid !== verifiedHead.cid || head.seq !== verifiedHead.seq) {
      if (!repairHead || this.readOnly) {
        throw new CorruptionError(
          `HEAD does not match verified chain head ${verifiedHead.cid} seq ${verifiedHead.seq}`
        );
      }
      await writeHeadAtomic(this.dir, verifiedHead);
    }

    this.headInfo = verifiedHead;
    this.chainVerifier = verifier;
    this.setSoulPublicKeyFromRecords(records);
  }

  /**
   * Re-walk the on-disk chain (seq-index prefix up to HEAD) into a fresh incremental verifier,
   * under the append lock, after another store instance advanced HEAD.
   */
  private async rebuildChainVerifier(): Promise<void> {
    const head = this.headInfo;
    if (head === null) {
      this.chainVerifier = new ChainVerifier(this.verifyOptions());
      return;
    }
    const entries = (await this.readSeqIndexSafe()).slice(0, head.seq + 1);
    const last = entries[entries.length - 1];
    if (entries.length !== head.seq + 1 || last === undefined || last.cid !== head.cid) {
      throw new CorruptionError(`HEAD ${head.cid} seq ${head.seq} does not match seq-index`);
    }
    const records = await this.loadRecordsFromIndex(entries);
    const { result, verifier } = await verifyRecordsWithState(records, this.verifyOptions());
    if (!result.valid) {
      throw chainVerificationCorruption(result.failures);
    }
    this.chainVerifier = verifier;
  }

  /** Chain verification options derived from the store's Door keys. */
  private verifyOptions(): { doorPublicKeys?: Readonly<Record<string, Uint8Array>> } {
    return this.doorPublicKeys === undefined ? {} : { doorPublicKeys: this.doorPublicKeys };
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

      let reCanonical: Uint8Array;
      try {
        reCanonical = canonicalize(parsed);
      } catch (error) {
        if (error instanceof EncodingError) {
          throw new CorruptionError(
            `non-canonical block bytes for CID ${entry.cid}: ${error.message}`
          );
        }
        throw error;
      }
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

  /**
   * Idempotent block put with byte-identity check on collision and durable fsync.
   *
   * An existing identical block is fsynced (file + shard dir + blocks dir) before returning —
   * a crashed writer may never have made it durable. An existing block whose bytes do not hash
   * to `cid` (torn / bit rot) is replaced atomically (temp → fsync → rename → dir fsync).
   */
  private async putBlockIdempotent(cid: string, bytes: Uint8Array): Promise<void> {
    const parsedCid = CID.parse(cid);
    const blockPath = resolveBlockPath(this.blocksPath, cid, this.shard);

    if (await this.blockstore.has(parsedCid)) {
      const existing = await collectBytes(this.blockstore.get(parsedCid));
      if (bytesEqual(existing, bytes)) {
        await this.fsyncBlock(blockPath);
        return;
      }
      if ((await computeCidFromCanonicalBytes(existing)) === cid) {
        // Unreachable without a sha2-256 collision; never overwrite bytes that verify.
        throw new CorruptionError(`block already exists for CID ${cid} with different bytes`);
      }
      // Torn/corrupt block: replace atomically, then make both directories durable.
      await assertBytesHashToCid(cid, bytes, "block");
      await writeFileAtomic(blockPath, bytes);
      await fsyncDirectory(this.blocksPath);
      return;
    }

    await assertBytesHashToCid(cid, bytes, "block");
    await this.blockstore.put(parsedCid, bytes);

    // FsBlockstore/steno does temp+rename with no fsync. Spec §3.2 requires the block
    // durable before seq-index/HEAD; sync the sharded .data file and both directories.
    await this.fsyncBlock(blockPath);
  }

  /** Fsync a block file, its shard directory, and the blocks root. */
  private async fsyncBlock(blockPath: string): Promise<void> {
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
