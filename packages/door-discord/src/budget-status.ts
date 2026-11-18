import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

/**
 * Tier names on the runtime snapshot. Kept in step with
 * `packages/runtime/src/brain/budget-status-file.ts`.
 */
const TIER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Remaining fraction in `[0, 1]`. `0`, `1`, or `0.` plus 1–6 digits and no
 * trailing zero. A dollar string does not match.
 */
const REMAINING_FRACTION = /^(?:0|1|0\.(?:[0-9]{0,5}[1-9]))$/;

/** Largest snapshot we will read. The real file is a few hundred bytes. */
const MAX_BUDGET_STATUS_BYTES = 1024;

const reportedStatusSchema = z
  .object({
    configured: z.literal(true),
    sleeping: z.boolean(),
    tier: z.string().regex(TIER_NAME).nullable(),
    remainingFraction: z.string().regex(REMAINING_FRACTION).nullable()
  })
  .strict();

const budgetStatusFileSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }).strict(),
  reportedStatusSchema
]);

/**
 * What `/wanderer status` may say about the budget.
 * `unavailable` means the file was missing or refused. The reason is for logs;
 * the reply does not include it, and it never includes file text.
 */
export type DoorBudgetStatus =
  | { state: "not_configured" }
  | { state: "unavailable"; reason: "missing" | "invalid" | "read_failed" }
  | {
      state: "reported";
      sleeping: boolean;
      tier: string | null;
      remainingFraction: string | null;
    };

/**
 * True when `filePath` is absolute, normalized, and has no `..` or NUL.
 * A bad path is not opened.
 *
 * @param filePath - Operator-supplied snapshot path.
 */
export function isBudgetStatusPath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/u);
  return (
    filePath.trim() !== "" &&
    !filePath.includes("\0") &&
    path.isAbsolute(filePath) &&
    !segments.includes("..") &&
    path.normalize(filePath) === filePath
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/**
 * Read the runtime's fraction-only snapshot.
 * An unset path is "not configured". A missing file, an empty file, a symlink,
 * a FIFO, a huge file, or a strict-schema failure (including any extra key such
 * as `balance`) is "unavailable". The bytes are not returned. The open uses
 * `O_NOFOLLOW` so a symlink is not followed, and `O_NONBLOCK` so a FIFO cannot
 * stall the event loop. A descriptor that is not a regular file is refused.
 *
 * @param filePath - `NPC_BUDGET_STATUS_PATH`, or `undefined` when unset.
 */
export function loadDoorBudgetStatus(filePath: string | undefined): DoorBudgetStatus {
  if (filePath === undefined || filePath === "") {
    return { state: "not_configured" };
  }
  if (!isBudgetStatusPath(filePath)) {
    return { state: "unavailable", reason: "invalid" };
  }
  let fd: number;
  try {
    // O_NOFOLLOW refuses a symlink. O_NONBLOCK keeps a FIFO from stalling the loop.
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { state: "unavailable", reason: "missing" };
    }
    return { state: "unavailable", reason: "read_failed" };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0 || info.size > MAX_BUDGET_STATUS_BYTES) {
      return { state: "unavailable", reason: "invalid" };
    }
    const buffer = Buffer.alloc(info.size);
    const bytesRead = readSync(fd, buffer, 0, info.size, 0);
    if (bytesRead !== info.size) {
      return { state: "unavailable", reason: "read_failed" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      return { state: "unavailable", reason: "invalid" };
    }
    const result = budgetStatusFileSchema.safeParse(parsed);
    if (!result.success) {
      return { state: "unavailable", reason: "invalid" };
    }
    if (result.data.configured === false) {
      return { state: "not_configured" };
    }
    return {
      state: "reported",
      sleeping: result.data.sleeping,
      tier: result.data.tier,
      remainingFraction: result.data.remainingFraction
    };
  } catch {
    return { state: "unavailable", reason: "read_failed" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing the descriptor must not replace a snapshot we already accepted.
    }
  }
}
