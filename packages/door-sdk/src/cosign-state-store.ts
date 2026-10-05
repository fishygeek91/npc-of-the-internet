import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CosignCommitResponseSchema } from "./schemas.js";

/** File name of the persisted cosign review state inside a {@link FileCosignStateStore} dir. */
export const COSIGN_STATE_FILE = "cosign-state.json";

const PersistedCommitSchema = z.object({
  shard_id: z.string().min(1),
  seq: z.number().int().positive(),
  core: z.string().min(1),
  response: CosignCommitResponseSchema
});

const PersistedEpochSchema = z.object({
  epoch: z.number().int().positive(),
  session_pubkey: z.string().min(1),
  /** Door-clock time the review completed (retention age). */
  reviewed_at: z.string().min(1),
  /** Approved `shard_id` → reviewed text (commit binding). Rejected text is never stored. */
  approved: z.array(z.object({ shard_id: z.string().min(1), text: z.string() })),
  /** Latest co-signed commit per `shard_id` (single-use binding + idempotent retry). */
  committed: z.array(PersistedCommitSchema)
});

/** On-disk cosign review state (version 1). */
export const PersistedCosignStateSchema = z.object({
  version: z.literal(1),
  door_id: z.string().min(1),
  epochs: z.array(PersistedEpochSchema)
});

/** Durable form of a Door's retained per-epoch cosign review state. */
export type PersistedCosignState = z.infer<typeof PersistedCosignStateSchema>;

/**
 * Durable store for a Door's retained per-epoch cosign review state (`spec/door/api.md`
 * — **Review retention**). Both methods are synchronous so the Door can persist a
 * single-use commit record before it returns the co-signature, with no `await` between
 * the single-use check and the update.
 */
export interface CosignStateStore {
  /** Load the last saved state, or `null` when none was ever saved. Throws on corruption. */
  load(): unknown;
  /** Replace the saved state; MUST be durable (fsync) before returning. */
  save(state: PersistedCosignState): void;
}

/**
 * {@link CosignStateStore} backed by one JSON file (`cosign-state.json`, mode `0600`) in
 * `dir`. Writes are atomic: temp file → fsync → rename → fsync directory, so a crash
 * leaves either the previous or the new state, never a torn file.
 */
export class FileCosignStateStore implements CosignStateStore {
  readonly path: string;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, COSIGN_STATE_FILE);
  }

  /**
   * Fail fast when the state directory is not writable (create, write, fsync and remove a
   * probe file). Call at boot: a save that fails only after a host review would make the
   * Door answer `internal_error` once the host has already acted.
   */
  assertWritable(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const probe = join(this.dir, `.write-probe-${String(process.pid)}`);
      const fd = openSync(probe, "w", 0o600);
      try {
        writeSync(fd, "ok");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      unlinkSync(probe);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`cosign state dir ${this.dir} is not writable: ${reason}`);
    }
  }

  load(): unknown {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error: unknown) {
      if (isErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    return JSON.parse(text) as unknown;
  }

  save(state: PersistedCosignState): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp-${String(process.pid)}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } catch (error: unknown) {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup of the partial temp file
      }
      throw error;
    }
    closeSync(fd);
    renameSync(tmp, this.path);
    fsyncDirectory(this.dir);
  }
}

/** fsync a directory so a rename inside it is durable (no-op where unsupported). */
function fsyncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch (error: unknown) {
    // Some platforms/filesystems refuse fsync on a directory handle.
    if (
      !isErrnoCode(error, "EISDIR") &&
      !isErrnoCode(error, "EINVAL") &&
      !isErrnoCode(error, "EPERM")
    ) {
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
