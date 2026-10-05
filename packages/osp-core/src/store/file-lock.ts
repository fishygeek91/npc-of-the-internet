import { randomBytes } from "node:crypto";
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

/**
 * On-disk lock metadata written after exclusive create.
 *
 * `nonce` identifies the acquiring {@link FileLock} instance. PIDs are not unique across
 * restarts — in a container, node is PID 1 on every boot — so a lock whose `pid` equals our
 * own PID is only live when its nonce is one this process currently holds.
 * Legacy locks (pre-nonce) carry only `pid` + `acquiredAt`.
 */
type LockMeta = {
  pid: number;
  acquiredAt: string;
  nonce?: string;
};

/**
 * Nonces of locks currently held by FileLock instances in THIS process.
 * Module-level so any instance can recognise another in-process holder.
 */
const heldNonces = new Set<string>();

/** Default liveness probe: true when `process.kill(pid, 0)` succeeds (process exists). */
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
  const nonce = "nonce" in parsed ? parsed.nonce : undefined;
  if (typeof nonce === "string" && nonce.length > 0) {
    return { pid, acquiredAt, nonce };
  }
  return { pid, acquiredAt };
}

/**
 * True when the lock described by `meta` may still be held by a live appender.
 *
 * - Same PID as this process: live only if the nonce is registered in this process
 *   ({@link heldNonces}). A same-PID lock with an unknown or missing nonce was left by a
 *   previous incarnation that reused our PID (e.g. container PID 1 after SIGKILL) — stale.
 * - Other PID: live while that process exists (unchanged pre-nonce behaviour).
 */
function isHolderLive(meta: LockMeta, isAlive: (pid: number) => boolean): boolean {
  if (meta.pid === process.pid) {
    return meta.nonce !== undefined && heldNonces.has(meta.nonce);
  }
  return isAlive(meta.pid);
}

/**
 * Exclusive file lock with PID+timestamp metadata for stale-lock recovery.
 */
export class FileLock {
  private readonly lockPath: string;
  private readonly maxAgeMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private lockFd: number | null;
  private nonce: string | null;

  /**
   * @param options.maxAgeMs - lock age beyond which recovery may steal a live holder's lock
   * @param options.isProcessAlive - liveness probe for OTHER PIDs (tests inject; defaults to
   *   `process.kill(pid, 0)`)
   */
  constructor(
    lockPath: string,
    options?: { maxAgeMs?: number; isProcessAlive?: (pid: number) => boolean }
  ) {
    this.lockPath = lockPath;
    this.maxAgeMs = options?.maxAgeMs ?? LOCK_MAX_AGE_MS;
    this.isAlive = options?.isProcessAlive ?? isProcessAlive;
    this.lockFd = null;
    this.nonce = null;
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
    const nonce = randomBytes(16).toString("hex");
    this.nonce = nonce;
    heldNonces.add(nonce);

    const meta: LockMeta = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce
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
    if (this.nonce !== null) {
      heldNonces.delete(this.nonce);
      this.nonce = null;
    }

    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Remove the lock file only when safe: dead PID, over max age, legacy/unparseable, or
   * carrying our own PID without a nonce this process holds (PID reuse across restarts).
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
      if (fresh && isHolderLive(meta, this.isAlive)) {
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
