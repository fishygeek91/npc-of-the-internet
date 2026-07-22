import { JournalError } from "./errors.js";

const SAFE_BASENAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Reject door ids that are empty or contain path traversal characters. */
export function assertSafeDoorId(doorId: string): void {
  if (doorId.trim().length === 0) {
    throw new JournalError("doorId must not be empty", "invalid_identifier");
  }
  if (doorId.includes("/") || doorId.includes("\\") || doorId.includes("..")) {
    throw new JournalError("doorId contains forbidden path characters", "invalid_identifier");
  }
}

/** Reject non-integer or negative residency epochs. */
export function assertSafeEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new JournalError("epoch must be a non-negative integer", "invalid_identifier");
  }
}

/**
 * Build the journal markdown filename for a door residency epoch.
 * Colons in `doorId` are replaced with underscores before embedding.
 */
export function buildJournalFilename(doorId: string, epoch: number): string {
  const safeDoorSegment = doorId.replaceAll(":", "_");
  const filename = `journal-${safeDoorSegment}-epoch-${String(epoch)}.md`;
  if (!SAFE_BASENAME_PATTERN.test(filename)) {
    throw new JournalError("journal filename contains unsafe characters", "invalid_identifier");
  }
  return filename;
}
