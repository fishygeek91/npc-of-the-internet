import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { JournalError } from "./errors.js";
import { assertSafeDoorId, assertSafeEpoch, buildJournalFilename } from "./journal-filename.js";

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
