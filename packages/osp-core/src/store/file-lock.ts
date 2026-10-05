import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";

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
 * Tolerance when comparing process start times. `Date.now() - process.uptime()` is stable
 * for one process (all threads and module instances observe the same value to within a few
 * milliseconds) but is derived from the wall clock, so allow for NTP slew and rounding.
 */
export const PROCESS_START_TOLERANCE_MS = 1_000;

/**
 * On-disk lock metadata written after exclusive create.
 *
 * `nonce` identifies the acquiring {@link FileLock} instance; `host` + `startedAt` identify the
 * acquiring process incarnation. PIDs are not unique across restarts — in a container, node
 * (or its init) gets the same small PID on every boot — so a same-PID lock is attributed to a
 * previous incarnation only when its recorded process start time differs from ours.
 * Legacy locks (v0.4.3 and earlier) carry only `pid` + `acquiredAt` (+ `nonce`).
 */
type LockMeta = {
  pid: number;
  acquiredAt: string;
  nonce?: string;
  /** `os.hostname()` of the acquiring process (container id under Docker). */
  host?: string;
  /** Acquiring process start time, epoch ms (`Date.now() - process.uptime() * 1000`). */
  startedAt?: number;
};

/**
 * Nonces of locks currently held by FileLock instances in THIS module instance.
 * Module-level so any instance can recognise another in-module holder. Workers and duplicate
 * module instances have their own registry; those holders are recognised by process identity.
 */
const heldNonces = new Set<string>();

/** Identity of the current process incarnation (start time is computed once per module). */
const PROCESS_IDENTITY: { host: string; startedAt: number } = {
  host: hostname(),
  startedAt: Math.round(Date.now() - process.uptime() * 1000)
};

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
  const meta: LockMeta = { pid, acquiredAt };
  const nonce = "nonce" in parsed ? parsed.nonce : undefined;
  if (typeof nonce === "string" && nonce.length > 0) {
    meta.nonce = nonce;
  }
  // Identity is all-or-nothing: a lock with a partial identity is treated as legacy.
  const host = "host" in parsed ? parsed.host : undefined;
  const startedAt = "startedAt" in parsed ? parsed.startedAt : undefined;
  if (
    typeof host === "string" &&
    host.length > 0 &&
    typeof startedAt === "number" &&
    Number.isFinite(startedAt)
  ) {
    meta.host = host;
    meta.startedAt = startedAt;
  }
  return meta;
}

/**
 * True when the lock described by `meta` may still be held by a live appender.
 *
 * Locks carrying a process identity (`host` + `startedAt`):
 * - Different host: the holder's PID namespace is not ours (another container sharing the
 *   volume) and cannot be probed — live (until {@link LOCK_MAX_AGE_MS}).
 * - Same host, other PID: live while that process exists.
 * - Same host, same PID, different start time (beyond {@link PROCESS_START_TOLERANCE_MS}): a
 *   previous incarnation that reused our PID (e.g. container PID 1 after SIGKILL) — stale.
 * - Same host, same PID, same start time: held inside THIS process — by this module instance
 *   (nonce registered) or by a worker thread / second module instance (nonce unknown to us).
 *   Live either way.
 *
 * Legacy locks (no identity; v0.4.3 and earlier): same PID is live only if the nonce is
 * registered here, otherwise stale (v0.4.3 ran a single store-opening process per container,
 * so a same-PID legacy lock can only be a previous incarnation's); other PID → liveness probe.
 */
function isHolderLive(meta: LockMeta, isAlive: (pid: number) => boolean): boolean {
  if (meta.host !== undefined && meta.startedAt !== undefined) {
    if (meta.host !== PROCESS_IDENTITY.host) {
      return true;
    }
    if (meta.pid !== process.pid) {
      return isAlive(meta.pid);
    }
    return Math.abs(meta.startedAt - PROCESS_IDENTITY.startedAt) <= PROCESS_START_TOLERANCE_MS;
  }
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
      nonce,
      host: PROCESS_IDENTITY.host,
      startedAt: PROCESS_IDENTITY.startedAt
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
   * Remove the lock file only when safe: dead PID, over max age, unparseable, or left by a
   * previous incarnation of a process that reused our PID (see {@link isHolderLive}).
   * Refuses while a live holder owns a fresh lock — including a holder in another thread or
   * module instance of this process, or in another container sharing the volume.
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
        const holder =
          meta.host === undefined ? `pid ${meta.pid}` : `pid ${meta.pid} on host ${meta.host}`;
        throw new ConcurrentAppendError(
          `another append is in progress (live .append.lock held by ${holder} since ${meta.acquiredAt} — refuse openWithRecovery)`
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
