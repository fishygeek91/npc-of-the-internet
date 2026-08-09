import { closeSync, existsSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";

import { ConcurrentAppendError, StorageError } from "../errors.js";

import { writeAllSync } from "./fsync.js";
import { isNodeError, nodeErrorMessage } from "./node-fs-error.js";

/**
 * Max age of a lock file before recovery may steal it even if the PID is alive.
 * v0.1 policy constant (appends are sub-second); a future config pass may surface this
 * via {@link FileLock} `options.maxAgeMs`.
 */
export const LOCK_MAX_AGE_MS = 3_600_000;

/** On-disk lock metadata written after exclusive create. */
type LockMeta = {
  pid: number;
  acquiredAt: string;
};

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
function parseLockMeta(raw: string): LockMeta | null {
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
 * Exclusive file lock with PID+timestamp metadata for stale-lock recovery.
 */
export class FileLock {
  private readonly lockPath: string;
  private readonly maxAgeMs: number;
  private lockFd: number | null;

  constructor(lockPath: string, options?: { maxAgeMs?: number }) {
    this.lockPath = lockPath;
    this.maxAgeMs = options?.maxAgeMs ?? LOCK_MAX_AGE_MS;
    this.lockFd = null;
  }

  /** Acquire the exclusive lock. */
  acquire(): void {
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

    const meta: LockMeta = {
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    };
    const metaBytes = new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
    try {
      writeAllSync(lockFd, metaBytes);
      fsyncSync(lockFd);
    } catch (error) {
      try {
        this.release();
      } catch {
        // Best-effort cleanup after failed lock metadata write.
      }
      throw new StorageError(`failed to write append lock metadata: ${nodeErrorMessage(error)}`);
    }
  }

  /**
   * Release the exclusive lock held by this instance.
   * No-op when this instance does not hold the lock (must not unlink another holder's file).
   */
  release(): void {
    if (this.lockFd === null) {
      return;
    }

    try {
      closeSync(this.lockFd);
    } catch {
      // Ignore close errors during lock cleanup.
    }
    this.lockFd = null;

    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Remove the lock file only when safe: dead PID, over max age, or legacy/unparseable.
   * Refuses while a live holder owns a fresh lock.
   */
  async clearStale(): Promise<void> {
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

    const meta = parseLockMeta(raw);
    if (meta !== null) {
      const acquiredMs = Date.parse(meta.acquiredAt);
      const ageMs = Number.isFinite(acquiredMs)
        ? Date.now() - acquiredMs
        : Number.POSITIVE_INFINITY;
      const fresh = ageMs < this.maxAgeMs;
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
}
