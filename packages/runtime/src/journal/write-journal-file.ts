import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { JournalError } from "./errors.js";

const SAFE_BASENAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSafeDoorId(doorId: string): void {
  if (doorId.trim().length === 0) {
    throw new JournalError("doorId must not be empty", "invalid_identifier");
  }
  if (doorId.includes("/") || doorId.includes("\\") || doorId.includes("..")) {
    throw new JournalError("doorId contains forbidden path characters", "invalid_identifier");
  }
}

function assertSafeEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new JournalError("epoch must be a non-negative integer", "invalid_identifier");
  }
}

function buildJournalFilename(doorId: string, epoch: number): string {
  const safeDoorSegment = doorId.replaceAll(":", "_");
  const filename = `journal-${safeDoorSegment}-epoch-${String(epoch)}.md`;
  if (!SAFE_BASENAME_PATTERN.test(filename)) {
    throw new JournalError("journal filename contains unsafe characters", "invalid_identifier");
  }
  return filename;
}

/**
 * Write a residency journal markdown file under `journalDir`.
 * Returns the absolute path written.
 */
export async function writeJournalFile(
  journalDir: string,
  doorId: string,
  epoch: number,
  markdown: string
): Promise<string> {
  assertSafeDoorId(doorId);
  assertSafeEpoch(epoch);

  const filename = buildJournalFilename(doorId, epoch);
  const resolvedDir = path.resolve(journalDir);
  const filePath = path.resolve(resolvedDir, filename);

  const relative = path.relative(resolvedDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new JournalError("journal path escapes journalDir", "invalid_identifier");
  }

  try {
    await mkdir(resolvedDir, { recursive: true });
    await writeFile(filePath, markdown, "utf8");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "write failed";
    throw new JournalError(`cannot write journal at ${filePath}: ${detail}`, "write_failed");
  }

  return filePath;
}
