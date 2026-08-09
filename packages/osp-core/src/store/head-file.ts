import { closeSync, existsSync, fsyncSync, openSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { isValidCid } from "../crypto/cid.js";
import { CorruptionError, StorageError } from "../errors.js";

import { fsyncDirectory, fsyncPath, writeAllSync } from "./fsync.js";
import { nodeErrorMessage } from "./node-fs-error.js";

import type { HeadInfo } from "./types.js";

const HEAD_FILE = "HEAD";
const HEAD_TMP_FILE = "HEAD.tmp";

/** Parse and validate HEAD JSON contents. */
function parseHeadJson(raw: string): HeadInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CorruptionError(`invalid HEAD JSON: ${nodeErrorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CorruptionError("HEAD must be a JSON object");
  }

  const cid = Reflect.get(parsed, "cid");
  const seq = Reflect.get(parsed, "seq");

  if (typeof cid !== "string" || !isValidCid(cid)) {
    throw new CorruptionError("HEAD cid must be a valid bagu CID string");
  }
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    throw new CorruptionError("HEAD seq must be a non-negative integer");
  }

  return { cid, seq };
}

/**
 * Read the atomic HEAD pointer file.
 *
 * @returns Parsed head info, or null when the file is absent.
 */
export async function readHead(dir: string): Promise<HeadInfo | null> {
  const headPath = path.join(dir, HEAD_FILE);

  if (!existsSync(headPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(headPath, "utf8");
  } catch (error) {
    throw new StorageError(`failed to read HEAD file: ${nodeErrorMessage(error)}`);
  }

  return parseHeadJson(raw);
}

/**
 * Atomically replace the HEAD pointer: write `HEAD.tmp`, fsync, rename to `HEAD`, fsync directory.
 */
export async function writeHeadAtomic(dir: string, head: HeadInfo): Promise<void> {
  const headPath = path.join(dir, HEAD_FILE);
  const tmpPath = path.join(dir, HEAD_TMP_FILE);
  const payload = new TextEncoder().encode(`${JSON.stringify({ cid: head.cid, seq: head.seq })}\n`);

  let fd: number;
  try {
    fd = openSync(tmpPath, "w");
  } catch (error) {
    throw new StorageError(`failed to create HEAD.tmp: ${nodeErrorMessage(error)}`);
  }

  try {
    writeAllSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmpPath, headPath);
  } catch (error) {
    throw new StorageError(`failed to rename HEAD.tmp to HEAD: ${nodeErrorMessage(error)}`);
  }

  await fsyncPath(headPath);
  await fsyncDirectory(dir);
}
