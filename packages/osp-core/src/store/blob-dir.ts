import { closeSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { computeCidFromCanonicalBytes, isValidCid } from "../crypto/cid.js";
import { CorruptionError, StorageError } from "../errors.js";

import { bytesEqual, fsyncDirectory, writeAllSync } from "./fsync.js";
import { isNodeError, nodeErrorMessage } from "./node-fs-error.js";

export type BlobMissingBehavior = "not_found" | "corruption";

/**
 * CID-addressed blob directory with idempotent writes and verified reads.
 */
export class BlobDir {
  constructor(readonly dirPath: string) {}

  /**
   * Write blob bytes, treating an existing byte-identical blob as already written
   * (idempotent retry after crash between blob and chain append).
   */
  async putIdempotent(cid: string, bytes: Uint8Array): Promise<void> {
    // invariant: cid is computed, not caller-supplied — assertion guards against a future refactor passing external input
    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }

    const blobPath = path.join(this.dirPath, cid);

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

  /**
   * Read blob bytes without CID verification.
   */
  async readBytes(cid: string, options?: { missingAs?: BlobMissingBehavior }): Promise<Uint8Array> {
    const missingAs = options?.missingAs ?? "not_found";

    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }

    const blobPath = path.join(this.dirPath, cid);
    let bytes: Buffer;
    try {
      bytes = await readFile(blobPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (missingAs === "corruption") {
          throw new CorruptionError(`missing blob for CID ${cid}`);
        }
        throw new StorageError(`record not found for CID ${cid}`);
      }
      throw new StorageError(`failed to read blob ${cid}: ${nodeErrorMessage(error)}`);
    }

    return new Uint8Array(bytes);
  }

  /**
   * Read blob bytes and verify the on-disk content matches the CID.
   */
  async readVerified(
    cid: string,
    options?: { missingAs?: BlobMissingBehavior }
  ): Promise<Uint8Array> {
    const canonicalBytes = await this.readBytes(cid, options);
    const computedCid = await computeCidFromCanonicalBytes(canonicalBytes);
    if (computedCid !== cid) {
      throw new CorruptionError(`blob CID mismatch for ${cid}: computed ${computedCid}`);
    }
    return canonicalBytes;
  }

  /**
   * Delete a blob file. Missing path is a no-op (idempotent erasure).
   */
  async delete(cid: string): Promise<void> {
    if (!isValidCid(cid)) {
      throw new StorageError(`invalid CID format: ${cid}`);
    }

    const blobPath = path.join(this.dirPath, cid);
    try {
      unlinkSync(blobPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw new StorageError(`failed to delete blob ${cid}: ${nodeErrorMessage(error)}`);
    }
    await fsyncDirectory(this.dirPath);
  }
}
