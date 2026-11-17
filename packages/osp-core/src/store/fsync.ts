import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
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
 * Minimum age (mtime) before an orphaned temp file is garbage-collected at store open.
 * Writes complete in well under a second; an hour leaves a wide margin for a concurrent
 * writer in another process whose temp file must not be removed mid-write.
 */
export const STALE_TEMP_MAX_AGE_MS = 3_600_000;

/**
 * Remove orphaned temp files (crash between temp write and rename) older than
 * {@link STALE_TEMP_MAX_AGE_MS} from `dirPath`. Only names matching `isTemp` are considered;
 * directories and younger files are left alone. Best-effort: a missing directory or a file
 * that vanishes or cannot be removed is skipped (GC must never block opening the store).
 *
 * @returns number of files removed
 */
export async function removeStaleTempFiles(
  dirPath: string,
  isTemp: (name: string) => boolean,
  options?: { maxAgeMs?: number; now?: number }
): Promise<number> {
  const maxAgeMs = options?.maxAgeMs ?? STALE_TEMP_MAX_AGE_MS;
  const now = options?.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(dirPath);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isTemp(name)) {
      continue;
    }
    const filePath = path.join(dirPath, name);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || now - info.mtimeMs < maxAgeMs) {
        continue;
      }
      await unlink(filePath);
      removed += 1;
    } catch {
      // Raced with another cleaner / writer, or not removable: leave it.
    }
  }
  if (removed > 0) {
    try {
      await fsyncDirectory(dirPath);
    } catch {
      // Best-effort: the unlinks are harmless if not yet durable.
    }
  }
  return removed;
}

/** True for temp files written by {@link writeFileAtomic}. */
export function isAtomicTempName(name: string): boolean {
  return name.startsWith(ATOMIC_TEMP_PREFIX);
}

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
