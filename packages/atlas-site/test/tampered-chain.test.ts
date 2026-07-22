import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSiteData } from "../src/lib/load-site-data.js";

const MULTI_RESIDENCY_FIXTURE_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "atlas",
  "test",
  "fixtures",
  "multi-residency"
);

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("loadSiteData with tampered chain", () => {
  it("succeeds with chainVerified false and unverified badges from the failure onward", async () => {
    const copyDir = await makeTempDir("atlas-site-tamper-");
    await cp(MULTI_RESIDENCY_FIXTURE_DIR, copyDir, { recursive: true });

    const chainPath = join(copyDir, "chain.jsonl");
    const beforeBytes = await readFile(chainPath);
    const truncated = beforeBytes.subarray(0, beforeBytes.length - 20);
    await writeFile(chainPath, truncated);

    const data = await loadSiteData({ ATLAS_SITE_CHAIN_DIR: copyDir });

    expect(data.chainVerified).toBe(false);
    expect(data.state.verified).toBe(false);
    expect(data.state.status).toBe("present");

    const verifiedCount = data.records.filter((record) => record.verified).length;
    const unverifiedCount = data.records.filter((record) => !record.verified).length;
    expect(verifiedCount).toBeGreaterThan(0);
    expect(unverifiedCount).toBeGreaterThan(0);
    expect(data.records[data.records.length - 1]?.verified).toBe(false);
  });
});
