import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type FileFingerprint = {
  path: string;
  sha256: string;
};

/** Recursively snapshot relative paths and sha256 digests for every file under `dir`. */
export async function snapshotDirectory(dir: string): Promise<FileFingerprint[]> {
  const fingerprints: FileFingerprint[] = [];

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        fingerprints.push({ path: relative, sha256 });
      }
    }
  }

  await walk(dir, "");
  fingerprints.sort((left, right) => left.path.localeCompare(right.path));
  return fingerprints;
}
