import path from "node:path";

import { JournalError } from "../journal/errors.js";
import {
  assertSafeDoorId,
  assertSafeEpoch,
  buildJournalFilename
} from "../journal/journal-filename.js";

/**
 * Resolve the absolute journal file path for a door residency epoch.
 * Uses the same filename rules as {@link writeJournalFile}.
 */
export function resolveJournalPath(journalDir: string, doorId: string, epoch: number): string {
  assertSafeDoorId(doorId);
  assertSafeEpoch(epoch);

  const filename = buildJournalFilename(doorId, epoch);
  const resolvedDir = path.resolve(journalDir);
  const filePath = path.resolve(resolvedDir, filename);

  const relative = path.relative(resolvedDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new JournalError("journal path escapes journalDir", "invalid_identifier");
  }

  return filePath;
}
