import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { readFile, stat, truncate } from "node:fs/promises";

import { isValidCid } from "../crypto/cid.js";
import { CorruptionError, StorageError } from "../errors.js";

import { fsyncPath, writeAllSync } from "./fsync.js";
import { isNodeError, nodeErrorMessage } from "./node-fs-error.js";

/** One seq-index journal line: ordered record pointer. */
export type SeqIndexEntry = {
  seq: number;
  cid: string;
};

/** Parse and validate one seq-index JSONL line. */
function parseSeqIndexLine(line: string, context: string): SeqIndexEntry {
  if (line.length === 0) {
    throw new CorruptionError(`empty line in ${context}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new CorruptionError(`invalid JSON in ${context}: ${nodeErrorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CorruptionError(`${context} must be a JSON object`);
  }

  const seq = Reflect.get(parsed, "seq");
  const cid = Reflect.get(parsed, "cid");

  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    throw new CorruptionError(`${context} seq must be a non-negative integer`);
  }
  if (typeof cid !== "string" || !isValidCid(cid)) {
    throw new CorruptionError(`${context} cid must be a valid bagu CID string`);
  }

  return { seq, cid };
}

/**
 * Append one seq-index journal line with fsync.
 */
export async function appendSeqIndex(path: string, entry: SeqIndexEntry): Promise<void> {
  const line = new TextEncoder().encode(`${JSON.stringify({ seq: entry.seq, cid: entry.cid })}\n`);

  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch (error) {
    throw new StorageError(`failed to open seq-index for append: ${nodeErrorMessage(error)}`);
  }

  try {
    writeAllSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the full seq-index journal.
 *
 * Missing or empty file returns []. A torn trailing line (no final newline) throws CorruptionError.
 */
export async function readSeqIndex(path: string): Promise<SeqIndexEntry[]> {
  if (!existsSync(path)) {
    return [];
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    throw new StorageError(`failed to read seq-index: ${nodeErrorMessage(error)}`);
  }

  if (buffer.length === 0) {
    return [];
  }

  if (buffer[buffer.length - 1] !== 0x0a) {
    throw new CorruptionError("truncated trailing line in seq-index");
  }

  const entries: SeqIndexEntry[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      const line = buffer.toString("utf8", start, index);
      entries.push(parseSeqIndexLine(line, "seq-index line"));
      start = index + 1;
    }
  }

  return entries;
}

/**
 * Truncate a torn seq-index tail (partial line without newline, or trailing blank lines).
 * Returns the number of bytes removed.
 */
export async function recoverTornSeqIndex(path: string): Promise<number> {
  let indexStat;
  try {
    indexStat = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const fd = openSync(path, "w");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return 0;
    }
    throw error;
  }

  if (indexStat.size === 0) {
    return 0;
  }

  const buffer = await readFile(path);
  const oldSize = buffer.length;
  let newSize = oldSize;

  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    let lastNewline = -1;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] === 0x0a) {
        lastNewline = index;
      }
    }
    newSize = lastNewline === -1 ? 0 : lastNewline + 1;
  }

  while (newSize >= 2 && buffer[newSize - 1] === 0x0a && buffer[newSize - 2] === 0x0a) {
    newSize -= 1;
  }
  if (newSize === 1 && buffer[0] === 0x0a) {
    newSize = 0;
  }

  if (newSize === oldSize) {
    return 0;
  }

  await truncate(path, newSize);
  await fsyncPath(path);
  return oldSize - newSize;
}
