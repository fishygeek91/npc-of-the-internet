import { closeSync, createReadStream, existsSync, fsyncSync, openSync } from "node:fs";
import { mkdir, readFile, stat, truncate } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

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
import { verifyRecords, type VerifyChainResult } from "../verify-chain.js";

import { BlobDir } from "./blob-dir.js";
import { FileLock } from "./file-lock.js";
import { bytesEqual, fsyncDirectory, fsyncPath, writeAllSync } from "./fsync.js";
import { isNodeError, nodeErrorMessage } from "./node-fs-error.js";

import type { ChainFailure } from "../chain-types.js";
import type {
  AppendResult,
  FileSoulStoreOpenOptions,
  HeadInfo,
  PutSideBlobResult,
  SoulStore
} from "./types.js";

const CHAIN_FILE = "chain.jsonl";
const BLOBS_DIR = "blobs";
const LOCK_FILE = ".append.lock";

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
  private readonly blobs: BlobDir;
  private readonly appendLock: FileLock;
  private readonly doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined;
  private readonly readOnly: boolean;
  private headInfo: HeadInfo | null;
  private soulPublicKey: Uint8Array | null;
  private verificationResult: VerifyChainResult;
  private closed: boolean;

  private constructor(
    dir: string,
    doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined,
    head: HeadInfo | null,
    soulPublicKey: Uint8Array | null,
    readOnly = false
  ) {
    this.dir = dir;
    this.chainPath = path.join(dir, CHAIN_FILE);
    this.blobs = new BlobDir(path.join(dir, BLOBS_DIR));
    this.appendLock = new FileLock(path.join(dir, LOCK_FILE));
    this.doorPublicKeys = doorPublicKeys;
    this.readOnly = readOnly;
    this.headInfo = head;
    this.soulPublicKey = soulPublicKey;
    this.verificationResult = { valid: true, head };
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

    await store.appendLock.clearStale();

    const truncatedBytes = await store.recoverTornChain();
    await store.loadChain();
    return { store, truncatedBytes };
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

    this.appendLock.acquire();

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
      await this.blobs.putIdempotent(cid, bytes);
      await fsyncDirectory(this.blobs.dirPath);

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
   * Shares the record blob directory; CID-keyed opaque bytes.
   */
  async putSideBlob(bytes: Uint8Array): Promise<PutSideBlobResult> {
    this.assertOpen();
    if (this.readOnly) {
      throw new StorageError("FileSoulStore is read-only");
    }
    const cid = await computeCidFromCanonicalBytes(bytes);
    await this.blobs.putIdempotent(cid, bytes);
    await fsyncDirectory(this.blobs.dirPath);
    return { cid };
  }

  /** Fetch side-blob bytes and verify CID identity. */
  async getSideBlob(cid: string): Promise<Uint8Array> {
    this.assertOpen();
    return this.blobs.readVerified(cid);
  }

  /** Remove side-blob bytes (idempotent erasure). */
  async deleteSideBlob(cid: string): Promise<void> {
    this.assertOpen();
    if (this.readOnly) {
      throw new StorageError("FileSoulStore is read-only");
    }
    await this.blobs.delete(cid);
  }

  /** Fetch a record by CID. */
  async get(cid: string): Promise<OspRecord> {
    this.assertOpen();

    const canonicalBytes = await this.blobs.readVerified(cid);

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

    this.appendLock.release();

    this.closed = true;
  }

  /** Ensure directory layout exists under the store root. */
  private async ensureLayout(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.blobs.dirPath, { recursive: true });
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
        await fsyncDirectory(this.dir);
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
    await fsyncPath(this.chainPath);
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
      await fsyncDirectory(this.dir);
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

    const verifyOptions: { doorPublicKeys?: Readonly<Record<string, Uint8Array>> } = {};
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

      const blobCanonical = await this.blobs.readBytes(cid, { missingAs: "corruption" });
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

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError("FileSoulStore is closed");
    }
  }
}
