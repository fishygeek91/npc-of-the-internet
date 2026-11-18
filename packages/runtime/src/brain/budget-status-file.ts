import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { BudgetPublicStatus } from "./budgeted-brain.js";
import { BrainError } from "./errors.js";

/**
 * Tier names accepted on the public snapshot. Same shape as `NPC_BRAIN_TIERS`
 * names. A value outside this pattern is not published.
 */
const TIER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Remaining / budget in `[0, 1]`, as `publicStatus` formats it: `0`, `1`, or
 * `0.` plus 1–6 digits with no trailing zero. Not a dollar amount.
 */
const REMAINING_FRACTION = /^(?:0|1|0\.(?:[0-9]{0,5}[1-9]))$/;

const reportedStatusSchema = z
  .object({
    configured: z.literal(true),
    sleeping: z.boolean(),
    tier: z.string().regex(TIER_NAME).nullable(),
    remainingFraction: z.string().regex(REMAINING_FRACTION).nullable()
  })
  .strict();

const unconfiguredStatusSchema = z
  .object({
    configured: z.literal(false)
  })
  .strict();

/**
 * On-disk snapshot the Discord Door reads for `/wanderer status`.
 * Not a Door wire message. `strict` so a `balance` (or any other) key is refused.
 * Door-discord keeps a matching reader schema.
 */
export const budgetStatusFileSchema = z.discriminatedUnion("configured", [
  unconfiguredStatusSchema,
  reportedStatusSchema
]);

/** Parsed {@link budgetStatusFileSchema}. */
export type BudgetStatusFile = z.infer<typeof budgetStatusFileSchema>;

/**
 * Public fields only. Drops `sleepReason` and `periodStart` so the file matches
 * what `/wanderer status` is allowed to show: sleeping, tier, remaining fraction.
 * `undefined` means treasury-lite is off (`configured: false`).
 *
 * @param status - Chat-tier {@link BudgetPublicStatus}, or `undefined` when no budget brain is open.
 */
export function budgetStatusBody(status: BudgetPublicStatus | undefined): BudgetStatusFile {
  if (status === undefined) {
    return { configured: false };
  }
  return {
    configured: true,
    sleeping: status.sleeping,
    tier: status.tier,
    remainingFraction: status.remainingFraction
  };
}

/**
 * Operator path for the snapshot. Absolute, no NUL, no `..` segment, already
 * normalized. The error names the variable and does not include the path.
 *
 * @param filePath - Candidate `NPC_BUDGET_STATUS_PATH`.
 * @throws {BrainError} When the path is not safe to join or create.
 */
export function assertBudgetStatusPath(filePath: string): void {
  const segments = filePath.split(/[/\\]/u);
  if (
    filePath.trim() === "" ||
    filePath.includes("\0") ||
    !path.isAbsolute(filePath) ||
    segments.includes("..") ||
    path.normalize(filePath) !== filePath
  ) {
    throw new BrainError(
      "NPC_BUDGET_STATUS_PATH must be an absolute path with no .. segment",
      "invalid_config",
      { envVar: "NPC_BUDGET_STATUS_PATH" }
    );
  }
}

/**
 * `NPC_BUDGET_STATUS_PATH` when set. Empty means the daemon does not publish.
 *
 * @param env - Process environment.
 * @throws {BrainError} When the value is set but not a safe absolute path.
 */
export function readBudgetStatusPath(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.NPC_BUDGET_STATUS_PATH?.trim() ?? "";
  if (raw === "") {
    return undefined;
  }
  assertBudgetStatusPath(raw);
  return raw;
}

/**
 * Filesystem calls {@link writeBudgetStatusFile} uses.
 * Production uses `node:fs/promises`. A test can pass a substitute that fails a write.
 */
export type BudgetStatusFileOps = {
  /** Create the parent directory. */
  mkdir: (dir: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  /** Write the temp file. */
  writeFile: (
    file: string,
    data: string,
    options: { encoding: "utf8"; mode: number }
  ) => Promise<void>;
  /** Rename the temp file onto the destination. */
  rename: (from: string, to: string) => Promise<void>;
  /** Remove the temp file after a failed write or rename. */
  unlink: (file: string) => Promise<void>;
};

const defaultBudgetStatusFs: BudgetStatusFileOps = {
  mkdir: async (dir, options) => {
    await mkdir(dir, options);
  },
  writeFile: async (file, data, options) => {
    await writeFile(file, data, options);
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  unlink: async (file) => {
    await unlink(file);
  }
};

/**
 * Atomically replace the snapshot. Validates before any write so a bad fraction
 * or an extra key never lands on disk. A crash can leave the previous file.
 * Power loss can leave an empty file, which the Door shows as `budget: unavailable`.
 * The next publish rewrites it. There is no fsync before the rename.
 * This is a cache of in-memory status, not the journal.
 *
 * @param filePath - Absolute destination.
 * @param body - Snapshot to publish.
 * @param fs - Filesystem operations. Defaults to Node's `fs/promises`.
 * @throws {BrainError} When the path or the body is not publishable. The message has no snapshot values.
 */
export async function writeBudgetStatusFile(
  filePath: string,
  body: BudgetStatusFile,
  fs: BudgetStatusFileOps = defaultBudgetStatusFs
): Promise<void> {
  assertBudgetStatusPath(filePath);
  const parsed = budgetStatusFileSchema.safeParse(body);
  if (!parsed.success) {
    throw new BrainError("refusing to publish a budget status snapshot", "invalid_config", {
      envVar: "NPC_BUDGET_STATUS_PATH"
    });
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${String(process.pid)}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(parsed.data)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, filePath);
  } catch (error: unknown) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Fields safe to log when a snapshot publish fails.
 * The destination path and the snapshot are not included.
 */
export type BudgetStatusPublishFailure = {
  /** Always `NPC_BUDGET_STATUS_PATH`. */
  envVar: "NPC_BUDGET_STATUS_PATH";
  /**
   * Node.js `error.code` when the filesystem call set one, otherwise the
   * {@link BrainError} reason, otherwise `publish_failed`.
   */
  code: string;
};

/** Ordered publisher. Failures are reported without the snapshot or the path. */
export type BudgetStatusPublisher = {
  /**
   * Queue `body`. Writes run one at a time so two publishes cannot tear the file.
   *
   * @param body - Snapshot taken at call time.
   */
  publish: (body: BudgetStatusFile) => void;
};

/**
 * Node `error.code` when it is a non-empty string. Anything else is ignored.
 *
 * @param error - A thrown filesystem or validation error.
 */
function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  if (typeof code !== "string" || code === "") {
    return undefined;
  }
  return code;
}

/**
 * Error code for a failed publish. Never the message, which may contain a path.
 *
 * @param error - Failure from validation or the filesystem.
 */
function publishFailureCode(error: unknown): string {
  const code = nodeErrorCode(error);
  if (code !== undefined) {
    return code;
  }
  if (error instanceof BrainError) {
    return error.reason;
  }
  return "publish_failed";
}

/**
 * Serialize snapshot writes. `onError` receives the env var and an error code.
 *
 * @param filePath - Absolute destination. Checked once at creation.
 * @param onError - Called when a write fails. Must not throw. The argument has no path.
 */
export function createBudgetStatusPublisher(
  filePath: string,
  onError: (failure: BudgetStatusPublishFailure) => void
): BudgetStatusPublisher {
  assertBudgetStatusPath(filePath);
  let chain: Promise<void> = Promise.resolve();
  return {
    publish(body: BudgetStatusFile): void {
      chain = chain
        .then(() => writeBudgetStatusFile(filePath, body))
        .catch((error: unknown) => {
          onError({
            envVar: "NPC_BUDGET_STATUS_PATH",
            code: publishFailureCode(error)
          });
        });
    }
  };
}
