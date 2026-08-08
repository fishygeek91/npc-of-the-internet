import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { mkdir, readFile, stat, truncate, unlink } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

import { canonicalize } from "../canonical.js";
import { computeCidFromCanonicalBytes, isValidCid } from "../crypto/cid.js";
import { decodePublicKey } from "../encoding/base64url.js";
import {
  ChainMismatchError,
  ConcurrentAppendError,
  CorruptionError,
  SchemaError,
  StorageError,
  VerificationError
} from "../errors.js";
import { verifyRecord } from "../record.js";
import { RecordSchema, type OspRecord } from "../schemas/index.js";
import { verifyRecords, type VerifyChainResult } from "../verify-chain.js";

import type { ChainFailure } from "../chain-types.js";
import type { AppendResult, FileSoulStoreOpenOptions, HeadInfo, SoulStore } from "./types.js";

const CHAIN_FILE = "chain.jsonl";
const BLOBS_DIR = "blobs";
const LOCK_FILE = ".append.lock";
/**
 * Max age of an `.append.lock` before `openWithRecovery` may steal it even if the PID is alive.
 * v0.1 policy constant (appends are sub-second); a future config pass may surface this.
 */
const LOCK_MAX_AGE_MS = 3_600_000;

/** On-disk lock metadata written after exclusive create. */
type AppendLockMeta = {
  pid: number;
  acquiredAt: string;
};

/** Compare two byte arrays for equality. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Write every byte of `data` to `fd`, looping until complete.
 * POSIX `write` may return a short count; ignoring it can fsync a torn line as durable.
 */
function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written === 0) {
      throw new StorageError("writeSync wrote 0 bytes before completing the buffer");
    }
    offset += written;
  }
}

/** True when `process.kill(pid, 0)` succeeds (process exists and is signalable). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse lock file contents; empty/legacy/invalid → null (treat as stale). */
function parseAppendLockMeta(raw: string): AppendLockMeta | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  if (!("pid" in parsed) || !("acquiredAt" in parsed)) {
    return null;
  }
  const pid = parsed.pid;
  const acquiredAt = parsed.acquiredAt;
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    return null;
  }
  if (typeof acquiredAt !== "string" || acquiredAt.length === 0) {
    return null;
  }
  return { pid, acquiredAt };
}

/**
 * Split chain file bytes into per-record canonical line payloads (without trailing newlines).
 * Any empty line (including a trailing blank after the final record) is corruption.
 */
function splitChainLines(buffer: Buffer): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      const lineLength = index - start;
      if (lineLength === 0) {
        throw new CorruptionError("empty line in chain file");
      }
      lines.push(new Uint8Array(buffer.subarray(start, index)));
      start = index + 1;
    }
  }

  return lines;
}

/**
 * Append-only file-backed soulchain store (JSONL chain + CID-addressed blobs).
 */
export class FileSoulStore implements SoulStore {
  private readonly dir: string;
  private readonly chainPath: string;
  private readonly blobsDir: string;
  private readonly lockPath: string;
  private readonly doorPublicKeys: readonly Uint8Array[] | undefined;
  private readonly readOnly: boolean;
  private headInfo: HeadInfo | null;
  private soulPublicKey: Uint8Array | null;
  private verificationResult: VerifyChainResult;
  private lockFd: number | null;
  private closed: boolean;

  private constructor(
    dir: string,
    doorPublicKeys: readonly Uint8Array[] | undefined,
    head: HeadInfo | null,
    soulPublicKey: Uint8Array | null,
    readOnly = false
  ) {
    this.dir = dir;
    this.chainPath = path.join(dir, CHAIN_FILE);
    this.blobsDir = path.join(dir, BLOBS_DIR);
    this.lockPath = path.join(dir, LOCK_FILE);
    this.doorPublicKeys = doorPublicKeys;
    this.readOnly = readOnly;
    this.headInfo = head;
    this.soulPublicKey = soulPublicKey;
    this.verificationResult = { valid: true, head };
    this.lockFd = null;
    this.closed = false;
  }

  /**
   * Open a soulchain directory. Never auto-truncates torn writes; use {@link openWithRecovery} instead.
   */
  static async open(dir: string, options?: FileSoulStoreOpenOptions): Promise<FileSoulStore> {
    const absoluteDir = path.resolve(dir);
    const store = new FileSoulStore(absoluteDir, options?.doorPublicKeys, null, null);
    await store.ensureLayout();
    await store.loadChain();
    return store;
  }

  /**
   * Open an existing soulchain directory for read-only access.
   *
   * Does not create directories or files, does not touch `.append.lock`, and does not truncate
   * torn trailing lines. Verification failures and torn tails are reported via {@link verification}
   * instead of throwing.
   */
  static async openReadOnly(
    dir: string,
    options?: FileSoulStoreOpenOptions
  ): Promise<FileSoulStore> {
    const absoluteDir = path.resolve(dir);

    if (!existsSync(absoluteDir)) {
      throw new StorageError(`soulchain directory does not exist: ${absoluteDir}`);
    }

    const chainPath = path.join(absoluteDir, CHAIN_FILE);
    if (!existsSync(chainPath)) {
      throw new StorageError(`chain file does not exist: ${chainPath}`);
    }

    const blobsDir = path.join(absoluteDir, BLOBS_DIR);
    if (!existsSync(blobsDir)) {
      throw new StorageError(`blobs directory does not exist: ${blobsDir}`);
    }

    const store = new FileSoulStore(absoluteDir, options?.doorPublicKeys, null, null, true);
    await store.loadChainReadOnly();
    return store;
  }

  /** Latest verification result from {@link open} or {@link openReadOnly} load. */
  verification(): VerifyChainResult {
    this.assertOpen();
    return this.verificationResult;
  }

  /**
   * Open a soulchain directory after recovering from a torn append.
   *
   * Removes a stale `.append.lock` if present (crash mid-append), truncates a partial trailing
   * chain line when the file lacks a terminating newline (and strips blank tails), then validates
   * like {@link open}.
   *
   * Must not run concurrently with live appenders on the same directory: lock clearing has a
   * read-then-unlink race (v0.1 single-host / manual recovery per RUNBOOK).
   */
  static async openWithRecovery(
    dir: string,
    options?: FileSoulStoreOpenOptions
  ): Promise<{ store: FileSoulStore; truncatedBytes: number }> {
    const absoluteDir = path.resolve(dir);
    const store = new FileSoulStore(absoluteDir, options?.doorPublicKeys, null, null);
    await store.ensureLayout();

    await store.clearStaleAppendLock();

    const truncatedBytes = await store.recoverTornChain();
    await store.loadChain();
    return { store, truncatedBytes };
  }

  /**
   * Remove `.append.lock` only when safe: dead PID, over max age, or legacy/unparseable.
   * Refuses while a live holder owns a fresh lock.
   *
   * TOCTOU: between reading meta and `unlink`, a new appender could recreate the lock and lose
   * it. Acceptable for v0.1 manual recovery; do not run recovery alongside live writers.
   */
  private async clearStaleAppendLock(): Promise<void> {
    if (!existsSync(this.lockPath)) {
      return;
    }

    let raw: string;
    try {
      raw = await readFile(this.lockPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw new StorageError(`failed to read append lock: ${nodeErrorMessage(error)}`);
    }

    const meta = parseAppendLockMeta(raw);
    if (meta !== null) {
      const acquiredMs = Date.parse(meta.acquiredAt);
      const ageMs = Number.isFinite(acquiredMs)
        ? Date.now() - acquiredMs
        : Number.POSITIVE_INFINITY;
      const fresh = ageMs < LOCK_MAX_AGE_MS;
      if (isProcessAlive(meta.pid) && fresh) {
        throw new ConcurrentAppendError(
          "another append is in progress (live .append.lock — refuse openWithRecovery)"
        );
      }
    }

    try {
      await unlink(this.lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /** Append a signed record to the chain and return its CID. */
  async append(record: OspRecord): Promise<AppendResult> {
    this.assertOpen();

    if (this.readOnly) {
      throw new StorageError("FileSoulStore is read-only");
    }

    const parsed = RecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new SchemaError(parsed.error.message);
    }
    const validatedRecord = parsed.data;

    this.acquireLock();

    try {
      // Re-read head from disk under the lock so a second store instance cannot fork the chain.
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
      await this.writeBlobIdempotent(cid, bytes);
      await FileSoulStore.fsyncDirectory(this.blobsDir);

      let chainFd: number;
      try {
        chainFd = openSync(this.chainPath, "a");
      } catch (error) {
        throw new StorageError(`failed to open chain file for append: ${nodeErrorMessage(error)}`);
      }

      try {
        const line = Buffer.concat([Buffer.from(bytes), Buffer.from("\n")]);
        writeAllSync(chainFd, line);
        fsyncSync(chainFd);
      } finally {
        closeSync(chainFd);
      }

      this.headInfo = { cid, seq: validatedRecord.seq };

      if (validatedRecord.seq === 0 && validatedRecord.type === "genesis") {
        this.soulPublicKey = decodePublicKey(validatedRecord.body.soul_pubkey);
      }

      return { cid };
    } finally {
      this.releaseLock();
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

  /** Fetch a record by CID. */
  async get(cid: string): Promise<OspRecord> {
    this.assertOpen();

    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }

    const blobPath = path.join(this.blobsDir, cid);
    let bytes: Buffer;
    try {
      bytes = await readFile(blobPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new StorageError(`record not found for CID ${cid}`);
      }
      throw new StorageError(`failed to read blob ${cid}: ${nodeErrorMessage(error)}`);
    }

    const canonicalBytes = new Uint8Array(bytes);
    const computedCid = await computeCidFromCanonicalBytes(canonicalBytes);
    if (computedCid !== cid) {
      throw new CorruptionError(`blob CID mismatch for ${cid}: computed ${computedCid}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(canonicalBytes));
    } catch (error) {
      throw new CorruptionError(`invalid JSON in blob ${cid}: ${nodeErrorMessage(error)}`);
    }

    const schemaResult = RecordSchema.safeParse(parsed);
    if (!schemaResult.success) {
      throw new SchemaError(schemaResult.error.message);
    }

    if (this.soulPublicKey !== null) {
      const verifyOptions: {
        soulPublicKey: Uint8Array;
        doorPublicKeys?: readonly Uint8Array[];
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
  async *iterate(): AsyncIterable<OspRecord> {
    this.assertOpen();

    const chainStat = await stat(this.chainPath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });

    if (chainStat === null || chainStat.size === 0) {
      return;
    }

    if (this.readOnly) {
      const buffer = await readFile(this.chainPath);
      const lineBytesList = splitChainLines(buffer);
      for (const lineBytes of lineBytesList) {
        yield this.parseRecordFromLineBytes(lineBytes, "chain line");
      }
      return;
    }

    const stream = createReadStream(this.chainPath, { encoding: "utf8" });
    const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of lineReader) {
        if (line.length === 0) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw new CorruptionError(`invalid JSON in chain line: ${nodeErrorMessage(error)}`);
        }

        const schemaResult = RecordSchema.safeParse(parsed);
        if (!schemaResult.success) {
          throw new SchemaError(schemaResult.error.message);
        }

        yield schemaResult.data;
      }
    } finally {
      lineReader.close();
      stream.destroy();
    }
  }

  /** Release resources held by this store. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.lockFd !== null) {
      this.releaseLock();
    }

    this.closed = true;
  }

  /** Ensure directory layout exists under the store root. */
  private async ensureLayout(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.blobsDir, { recursive: true });
  }

  /**
   * Re-read the on-disk chain head under the append lock.
   * Prevents two open store instances from forking the chain via a stale in-memory head.
   */
  private async refreshHeadFromDisk(): Promise<void> {
    let buffer: Buffer;
    try {
      buffer = await readFile(this.chainPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.headInfo = null;
        return;
      }
      throw new StorageError(`failed to refresh head from disk: ${nodeErrorMessage(error)}`);
    }

    if (buffer.length === 0) {
      this.headInfo = null;
      return;
    }

    if (buffer[buffer.length - 1] !== 0x0a) {
      throw new CorruptionError("truncated trailing line");
    }

    const lines = splitChainLines(buffer);
    if (lines.length === 0) {
      this.headInfo = null;
      return;
    }

    const lastLine = lines[lines.length - 1];
    if (lastLine === undefined) {
      this.headInfo = null;
      return;
    }

    if (this.soulPublicKey === null) {
      const firstLine = lines[0];
      if (firstLine !== undefined) {
        let firstParsed: unknown;
        try {
          firstParsed = JSON.parse(new TextDecoder().decode(firstLine));
        } catch (error) {
          throw new CorruptionError(
            `invalid JSON in chain genesis during refresh: ${nodeErrorMessage(error)}`
          );
        }
        const firstSchema = RecordSchema.safeParse(firstParsed);
        if (firstSchema.success && firstSchema.data.type === "genesis") {
          this.soulPublicKey = decodePublicKey(firstSchema.data.body.soul_pubkey);
        }
      }
    }

    const cid = await computeCidFromCanonicalBytes(lastLine);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(lastLine));
    } catch (error) {
      throw new CorruptionError(
        `invalid JSON in chain head during refresh: ${nodeErrorMessage(error)}`
      );
    }

    const schemaResult = RecordSchema.safeParse(parsed);
    if (!schemaResult.success) {
      throw new CorruptionError(
        `invalid record at chain head during refresh: ${schemaResult.error.message}`
      );
    }

    this.headInfo = { cid, seq: schemaResult.data.seq };
  }

  /**
   * Write blob bytes, treating an existing byte-identical blob as already written
   * (idempotent retry after crash between blob and chain append).
   */
  private async writeBlobIdempotent(cid: string, bytes: Uint8Array): Promise<void> {
    // invariant: cid is computed, not caller-supplied — assertion guards against a future refactor passing external input
    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }

    const blobPath = path.join(this.blobsDir, cid);

    let blobFd: number;
    try {
      blobFd = openSync(blobPath, "wx");
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        let existing: Buffer;
        try {
          existing = await readFile(blobPath);
        } catch (readError) {
          throw new StorageError(
            `failed to read existing blob ${cid}: ${nodeErrorMessage(readError)}`
          );
        }
        if (bytesEqual(new Uint8Array(existing), bytes)) {
          return;
        }
        throw new CorruptionError(`blob already exists for CID ${cid} with different bytes`);
      }
      throw new StorageError(`failed to create blob ${cid}: ${nodeErrorMessage(error)}`);
    }

    try {
      writeAllSync(blobFd, bytes);
      fsyncSync(blobFd);
    } finally {
      closeSync(blobFd);
    }
  }

  /** Truncate a torn chain file; returns the number of bytes removed. */
  private async recoverTornChain(): Promise<number> {
    let chainStat;
    try {
      chainStat = await stat(this.chainPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const fd = openSync(this.chainPath, "w");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        await FileSoulStore.fsyncDirectory(this.dir);
        return 0;
      }
      throw error;
    }

    if (chainStat.size === 0) {
      return 0;
    }

    const buffer = await readFile(this.chainPath);
    const oldSize = buffer.length;
    let newSize = oldSize;

    // Torn trailing line (no final newline): truncate to last complete line.
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
      let lastNewline = -1;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] === 0x0a) {
          lastNewline = index;
        }
      }
      newSize = lastNewline === -1 ? 0 : lastNewline + 1;
    }

    // Strip trailing empty lines (`record\n\n`) so the next append cannot brick the store.
    while (newSize >= 2 && buffer[newSize - 1] === 0x0a && buffer[newSize - 2] === 0x0a) {
      newSize -= 1;
    }
    // Lone `\n` (empty-line-only file) cannot be reduced by the loop above (needs length ≥ 2).
    if (newSize === 1 && buffer[0] === 0x0a) {
      newSize = 0;
    }

    if (newSize === oldSize) {
      return 0;
    }

    await truncate(this.chainPath, newSize);
    await FileSoulStore.fsyncPath(this.chainPath);
    return oldSize - newSize;
  }

  /** Read and validate the on-disk chain, populating head and soul public key. */
  private async loadChain(): Promise<void> {
    if (!existsSync(this.chainPath)) {
      const fd = openSync(this.chainPath, "w");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await FileSoulStore.fsyncDirectory(this.dir);
      this.headInfo = null;
      this.soulPublicKey = null;
      this.verificationResult = { valid: true, head: null };
      return;
    }

    // TODO(T7.1): stream loadChain for large chains
    const buffer = await readFile(this.chainPath);
    if (buffer.length === 0) {
      this.headInfo = null;
      this.soulPublicKey = null;
      this.verificationResult = { valid: true, head: null };
      return;
    }

    if (buffer[buffer.length - 1] !== 0x0a) {
      throw new CorruptionError("truncated trailing line");
    }

    const lineBytesList = splitChainLines(buffer);
    if (lineBytesList.length === 0) {
      this.headInfo = null;
      this.soulPublicKey = null;
      this.verificationResult = { valid: true, head: null };
      return;
    }

    const records = await this.parseChainLineBytes(lineBytesList);

    const verifyOptions: { doorPublicKeys?: readonly Uint8Array[] } = {};
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
    this.verificationResult = { valid: true, head: verifyResult.head };
    this.setSoulPublicKeyFromRecords(records);
  }

  /**
   * Soft-load the on-disk chain for read-only access.
   *
   * Torn trailing lines are ignored in memory (not truncated on disk). Verification failures
   * are recorded in {@link verificationResult} instead of throwing.
   */
  private async loadChainReadOnly(): Promise<void> {
    const buffer = await readFile(this.chainPath);
    if (buffer.length === 0) {
      this.headInfo = null;
      this.soulPublicKey = null;
      this.verificationResult = { valid: true, head: null };
      return;
    }

    const tornTail = buffer[buffer.length - 1] !== 0x0a;
    const lineBytesList = splitChainLines(buffer);

    if (lineBytesList.length === 0) {
      this.headInfo = null;
      this.soulPublicKey = null;
      if (tornTail) {
        this.verificationResult = {
          valid: false,
          failures: [
            {
              seq: 0,
              rule: "schema_violation",
              message: "truncated trailing line ignored in read-only open"
            }
          ]
        };
      } else {
        this.verificationResult = { valid: true, head: null };
      }
      return;
    }

    const records = await this.parseChainLineBytes(lineBytesList);

    const verifyOptions: { doorPublicKeys?: readonly Uint8Array[] } = {};
    if (this.doorPublicKeys !== undefined) {
      verifyOptions.doorPublicKeys = this.doorPublicKeys;
    }

    const verifyResult = await verifyRecords(records, verifyOptions);
    const lastLine = lineBytesList[lineBytesList.length - 1];
    if (lastLine === undefined) {
      this.headInfo = null;
    } else {
      this.headInfo = await this.headInfoFromLineBytes(lastLine);
    }
    this.setSoulPublicKeyFromRecords(records);

    const failures: ChainFailure[] = verifyResult.valid ? [] : [...verifyResult.failures];
    if (tornTail) {
      const lastSeq = this.headInfo?.seq ?? 0;
      failures.push({
        seq: lastSeq,
        rule: "schema_violation",
        message: "truncated trailing line ignored in read-only open"
      });
    }

    if (!verifyResult.valid || tornTail) {
      this.verificationResult = { valid: false, failures };
    } else {
      this.verificationResult = { valid: true, head: this.headInfo };
    }
  }

  /** Parse canonical chain line bytes into raw record JSON, verifying blob integrity. */
  private async parseChainLineBytes(lineBytesList: Uint8Array[]): Promise<unknown[]> {
    const records: unknown[] = [];

    for (const lineBytes of lineBytesList) {
      const cid = await computeCidFromCanonicalBytes(lineBytes);
      // invariant: cid is computed, not caller-supplied — assertion guards against a future refactor passing external input
      if (!isValidCid(cid)) {
        throw new StorageError(`invalid CID format: ${cid}`);
      }

      const blobPath = path.join(this.blobsDir, cid);

      let blobBytes: Buffer;
      try {
        blobBytes = await readFile(blobPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new CorruptionError(`missing blob for CID ${cid}`);
        }
        throw new StorageError(`failed to read blob ${cid}: ${nodeErrorMessage(error)}`);
      }

      const blobCanonical = new Uint8Array(blobBytes);
      if (!bytesEqual(lineBytes, blobCanonical)) {
        throw new CorruptionError(`blob bytes mismatch for CID ${cid}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(lineBytes));
      } catch (error) {
        throw new CorruptionError(
          `invalid JSON in chain for CID ${cid}: ${nodeErrorMessage(error)}`
        );
      }

      const reCanonical = canonicalize(parsed);
      if (!bytesEqual(lineBytes, reCanonical)) {
        throw new CorruptionError(`non-canonical chain line for CID ${cid}`);
      }

      records.push(parsed);
    }

    return records;
  }

  /** Derive head info from a single canonical chain line. */
  private async headInfoFromLineBytes(lineBytes: Uint8Array): Promise<HeadInfo> {
    const cid = await computeCidFromCanonicalBytes(lineBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(lineBytes));
    } catch (error) {
      throw new CorruptionError(`invalid JSON in chain head: ${nodeErrorMessage(error)}`);
    }

    const reCanonical = canonicalize(parsed);
    if (!bytesEqual(lineBytes, reCanonical)) {
      throw new CorruptionError(`non-canonical chain line for CID ${cid}`);
    }

    const schemaResult = RecordSchema.safeParse(parsed);
    if (!schemaResult.success) {
      throw new CorruptionError(`invalid record at chain head: ${schemaResult.error.message}`);
    }

    return { cid, seq: schemaResult.data.seq };
  }

  /** Parse a chain line into a validated record (iterate helper). */
  private parseRecordFromLineBytes(lineBytes: Uint8Array, context: string): OspRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(lineBytes));
    } catch (error) {
      throw new CorruptionError(`invalid JSON in ${context}: ${nodeErrorMessage(error)}`);
    }

    const schemaResult = RecordSchema.safeParse(parsed);
    if (!schemaResult.success) {
      throw new SchemaError(schemaResult.error.message);
    }

    return schemaResult.data;
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

  /** Acquire the exclusive append lock. */
  private acquireLock(): void {
    let lockFd: number;
    try {
      lockFd = openSync(this.lockPath, "wx");
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ConcurrentAppendError(
          "another append is in progress (or a stale .append.lock remains after a crash — use openWithRecovery)"
        );
      }
      throw new StorageError(`failed to acquire append lock: ${nodeErrorMessage(error)}`);
    }

    this.lockFd = lockFd;

    const meta: AppendLockMeta = {
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    };
    const metaBytes = new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
    try {
      writeAllSync(lockFd, metaBytes);
      fsyncSync(lockFd);
    } catch (error) {
      try {
        this.releaseLock();
      } catch {
        // Best-effort cleanup after failed lock metadata write.
      }
      throw new StorageError(`failed to write append lock metadata: ${nodeErrorMessage(error)}`);
    }
  }

  /** Release the exclusive append lock. */
  private releaseLock(): void {
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd);
      } catch {
        // Ignore close errors during lock cleanup.
      }
      this.lockFd = null;
    }

    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError("FileSoulStore is closed");
    }
  }

  private static async fsyncPath(targetPath: string): Promise<void> {
    let fd: number;
    try {
      fd = openSync(targetPath, "r");
    } catch (error) {
      throw new StorageError(`failed to open for fsync: ${nodeErrorMessage(error)}`);
    }

    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private static async fsyncDirectory(dirPath: string): Promise<void> {
    let fd: number;
    try {
      fd = openSync(dirPath, "r");
    } catch (error) {
      throw new StorageError(`failed to open directory for fsync: ${nodeErrorMessage(error)}`);
    }

    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

type NodeError = Error & { code?: string };

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && "code" in error;
}

function nodeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
