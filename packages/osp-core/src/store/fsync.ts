import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import * as path from "node:path";

import { StorageError } from "../errors.js";

import { nodeErrorMessage } from "./node-fs-error.js";

/** Compare two byte arrays for equality. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
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
export function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written === 0) {
      throw new StorageError("writeSync wrote 0 bytes before completing the buffer");
    }
    offset += written;
  }
}

/** Fsync a file path by opening read-only and calling fsyncSync. */
export async function fsyncPath(targetPath: string): Promise<void> {
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

/** Fsync a directory path by opening read-only and calling fsyncSync. */
export async function fsyncDirectory(dirPath: string): Promise<void> {
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

/** Prefix of temp files written by {@link writeFileAtomic}; never a valid CID. */
export const ATOMIC_TEMP_PREFIX = ".tmp-";

/**
 * Durably and atomically (re)place `finalPath` with `data`: write a temp file in the same
 * directory → fsync → rename over `finalPath` → fsync the directory. A crash leaves either the
 * old file, the complete new file, or an orphan temp file (prefixed {@link ATOMIC_TEMP_PREFIX})
 * — never a torn `finalPath`.
 */
export async function writeFileAtomic(finalPath: string, data: Uint8Array): Promise<void> {
  const dirPath = path.dirname(finalPath);
  const tempPath = path.join(
    dirPath,
    `${ATOMIC_TEMP_PREFIX}${path.basename(finalPath)}-${process.pid}-${randomBytes(6).toString("hex")}`
  );

  let fd: number;
  try {
    fd = openSync(tempPath, "wx");
  } catch (error) {
    throw new StorageError(`failed to create temp file: ${nodeErrorMessage(error)}`);
  }

  try {
    try {
      writeAllSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, finalPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort temp cleanup; the original error is what matters.
    }
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(`failed to write ${finalPath} atomically: ${nodeErrorMessage(error)}`);
  }

  await fsyncDirectory(dirPath);
}
