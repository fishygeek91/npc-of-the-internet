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
 * Atomically replace the snapshot. Validates before any write so a bad fraction
 * or an extra key never lands on disk. A crash can leave the previous file;
 * the next publish rewrites it. This is a cache of in-memory status, not the journal.
 *
 * @param filePath - Absolute destination.
 * @param body - Snapshot to publish.
 * @throws {BrainError} When the path or the body is not publishable. The message has no snapshot values.
 */
export async function writeBudgetStatusFile(
  filePath: string,
  body: BudgetStatusFile
): Promise<void> {
  assertBudgetStatusPath(filePath);
  const parsed = budgetStatusFileSchema.safeParse(body);
  if (!parsed.success) {
    throw new BrainError("refusing to publish a budget status snapshot", "invalid_config", {
      envVar: "NPC_BUDGET_STATUS_PATH"
    });
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${JSON.stringify(parsed.data)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temp, filePath);
  } catch (error: unknown) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Ordered publisher. Failures are reported without the snapshot. */
export type BudgetStatusPublisher = {
  /**
   * Queue `body`. Writes run one at a time so two publishes cannot tear the file.
   *
   * @param body - Snapshot taken at call time.
   */
  publish: (body: BudgetStatusFile) => void;
};

/**
 * Serialize snapshot writes. `onError` receives the error message only.
 *
 * @param filePath - Absolute destination. Checked once at creation.
 * @param onError - Called when a write fails. Must not throw.
 */
export function createBudgetStatusPublisher(
  filePath: string,
  onError: (message: string) => void
): BudgetStatusPublisher {
  assertBudgetStatusPath(filePath);
  let chain: Promise<void> = Promise.resolve();
  return {
    publish(body: BudgetStatusFile): void {
      chain = chain
        .then(() => writeBudgetStatusFile(filePath, body))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "budget status publish failed";
          onError(message);
        });
    }
  };
}
