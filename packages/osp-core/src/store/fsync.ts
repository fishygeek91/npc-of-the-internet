import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

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
