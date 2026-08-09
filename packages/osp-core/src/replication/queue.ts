import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { readFile, stat, truncate } from "node:fs/promises";
import * as path from "node:path";

import { CorruptionError, StorageError } from "../errors.js";
import { fsyncPath, writeAllSync } from "../store/fsync.js";
import { isNodeError, nodeErrorMessage } from "../store/node-fs-error.js";

import {
  ReplicationAckEntrySchema,
  ReplicationEnqueueEntrySchema,
  type ReplicationAckEntry,
  type ReplicationEnqueueEntry
} from "./types.js";

const REPLICATION_FILE = "replication.jsonl";

/** Parsed enqueue line from the replication journal (with type discriminator). */
export type ReplicationJournalEnqueueLine = ReplicationEnqueueEntry & { type: "enqueue" };

/** Parsed ack line from the replication journal (with type discriminator). */
export type ReplicationJournalAckLine = ReplicationAckEntry & { type: "ack" };

/** One parsed line from `replication.jsonl`. */
export type ReplicationJournalEntry = ReplicationJournalEnqueueLine | ReplicationJournalAckLine;

/** Resolve the on-disk path for the replication journal under an IPFS soulchain directory. */
export function replicationJournalPath(dir: string): string {
  return path.join(dir, REPLICATION_FILE);
}

/**
 * Parse and validate one replication journal JSONL line.
 *
 * Enqueue lines carry `cid`, `kind`, `enqueued_at`. Ack lines carry `acked`, `target`, `at`.
 */
function parseJournalLine(line: string, context: string): ReplicationJournalEntry {
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

  const acked = Reflect.get(parsed, "acked");
  if (acked !== undefined) {
    const ackResult = ReplicationAckEntrySchema.safeParse(parsed);
    if (ackResult.success) {
      return { type: "ack", ...ackResult.data };
    }
    throw new CorruptionError(`invalid ack line in ${context}: ${ackResult.error.message}`);
  }

  const enqueueResult = ReplicationEnqueueEntrySchema.safeParse(parsed);
  if (enqueueResult.success) {
    return { type: "enqueue", ...enqueueResult.data };
  }
  throw new CorruptionError(`invalid enqueue line in ${context}: ${enqueueResult.error.message}`);
}

/**
 * Append one enqueue entry to `replication.jsonl` with fsync.
 *
 * Concurrent writers are undefined in v0 — append + fsync only; no FileLock.
 */
export async function enqueueReplication(
  dir: string,
  entry: ReplicationEnqueueEntry
): Promise<void> {
  const validated = ReplicationEnqueueEntrySchema.parse(entry);
  const journalPath = replicationJournalPath(dir);
  const line = new TextEncoder().encode(
    `${JSON.stringify({
      cid: validated.cid,
      kind: validated.kind,
      enqueued_at: validated.enqueued_at
    })}\n`
  );

  let fd: number;
  try {
    fd = openSync(journalPath, "a");
  } catch (error) {
    throw new StorageError(
      `failed to open replication journal for append: ${nodeErrorMessage(error)}`
    );
  }

  try {
    writeAllSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one ack entry to `replication.jsonl` with fsync.
 *
 * Idempotent: duplicate acks for the same cid+target are allowed.
 */
export async function ackReplication(dir: string, entry: ReplicationAckEntry): Promise<void> {
  const validated = ReplicationAckEntrySchema.parse(entry);
  const journalPath = replicationJournalPath(dir);
  const line = new TextEncoder().encode(
    `${JSON.stringify({
      acked: validated.acked,
      target: validated.target,
      at: validated.at
    })}\n`
  );

  let fd: number;
  try {
    fd = openSync(journalPath, "a");
  } catch (error) {
    throw new StorageError(
      `failed to open replication journal for ack: ${nodeErrorMessage(error)}`
    );
  }

  try {
    writeAllSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the full replication journal.
 *
 * Missing or empty file returns []. A torn trailing line (no final newline) throws CorruptionError.
 */
export async function readReplicationJournal(dir: string): Promise<ReplicationJournalEntry[]> {
  const journalPath = replicationJournalPath(dir);

  if (!existsSync(journalPath)) {
    return [];
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(journalPath);
  } catch (error) {
    throw new StorageError(`failed to read replication journal: ${nodeErrorMessage(error)}`);
  }

  if (buffer.length === 0) {
    return [];
  }

  if (buffer[buffer.length - 1] !== 0x0a) {
    throw new CorruptionError("truncated trailing line in replication journal");
  }

  const entries: ReplicationJournalEntry[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      const line = buffer.toString("utf8", start, index);
      entries.push(parseJournalLine(line, "replication journal line"));
      start = index + 1;
    }
  }

  return entries;
}

/**
 * Truncate a torn replication journal tail (partial line without newline, or trailing blank lines).
 * Returns the number of bytes removed.
 */
export async function recoverReplicationJournal(dir: string): Promise<number> {
  const journalPath = replicationJournalPath(dir);

  let indexStat;
  try {
    indexStat = await stat(journalPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const fd = openSync(journalPath, "w");
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

  const buffer = await readFile(journalPath);
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

  await truncate(journalPath, newSize);
  await fsyncPath(journalPath);
  return oldSize - newSize;
}

/**
 * Enqueue entries that have no ack line yet for their CID on **any** target.
 *
 * A single ack from one target removes the CID from this list — it is **not** a
 * "fully replicated to all targets" check. Use {@link listUnackedForTarget} for
 * per-target pending work (drain loop). Current callers use this only for
 * enqueue dedupe (`enqueueIfNotPending`).
 */
export async function listPendingReplication(dir: string): Promise<ReplicationEnqueueEntry[]> {
  const journal = await readReplicationJournal(dir);
  const ackedCids = new Set<string>();

  for (const entry of journal) {
    if (entry.type === "ack") {
      ackedCids.add(entry.acked);
    }
  }

  const pending: ReplicationEnqueueEntry[] = [];
  for (const entry of journal) {
    if (entry.type === "enqueue" && !ackedCids.has(entry.cid)) {
      pending.push({
        cid: entry.cid,
        kind: entry.kind,
        enqueued_at: entry.enqueued_at
      });
    }
  }

  return pending;
}

/**
 * Enqueue entries not yet acked for a specific replication target.
 *
 * Keeps enqueues in journal order; an enqueue is pending when no ack exists with matching
 * `acked` + `target`.
 */
export async function listUnackedForTarget(
  dir: string,
  target: string
): Promise<ReplicationEnqueueEntry[]> {
  const journal = await readReplicationJournal(dir);
  const ackedForTarget = new Set<string>();

  for (const entry of journal) {
    if (entry.type === "ack" && entry.target === target) {
      ackedForTarget.add(entry.acked);
    }
  }

  const pending: ReplicationEnqueueEntry[] = [];
  for (const entry of journal) {
    if (entry.type === "enqueue" && !ackedForTarget.has(entry.cid)) {
      pending.push({
        cid: entry.cid,
        kind: entry.kind,
        enqueued_at: entry.enqueued_at
      });
    }
  }

  return pending;
}
