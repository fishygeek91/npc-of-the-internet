import { mkdtemp, rm } from "node:fs/promises";
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

function fixtureEnv(chainDir: string): NodeJS.ProcessEnv {
  return {
    ATLAS_SITE_CHAIN_DIR: chainDir
  };
}

describe("loadSiteData", () => {
  it("loads the multi-residency fixture with expected derived data", async () => {
    const data = await loadSiteData(fixtureEnv(MULTI_RESIDENCY_FIXTURE_DIR));

    expect(data.state).toMatchObject({
      status: "present",
      door_id: "irc:libera-wanderer",
      epoch: 2,
      verified: true
    });
    expect(data.chainVerified).toBe(true);
    expect(data.journey).toHaveLength(2);
    expect(data.journey[0]).toMatchObject({
      door_id: "discord:g",
      epoch: 1
    });
    expect(data.journey[1]).toMatchObject({
      door_id: "irc:libera-wanderer",
      epoch: 2
    });
    expect(data.journals).toHaveLength(2);
    expect(data.totalRecords).toBe(9);
    expect(data.recordsPages).toHaveLength(2);
    expect(data.recordsPages[0]?.per_page).toBe(5);
    expect(data.recordsPages[0]?.records).toHaveLength(5);
    expect(data.recordsPages[1]?.records).toHaveLength(4);
    expect(data.records).toHaveLength(9);
    expect(data.records.every((record) => record.verified)).toBe(true);
    expect(data.recordTypes).toContain("genesis");
    expect(data.recordTypes).toContain("attestation");
    expect(data.recordTypes).toContain("memory");
  });

  it("throws when ATLAS_SITE_CHAIN_DIR is missing", async () => {
    await expect(loadSiteData({})).rejects.toThrow(/ATLAS_SITE_CHAIN_DIR/);
  });

  it("throws when ATLAS_SITE_CHAIN_DIR does not contain chain.jsonl", async () => {
    const emptyDir = await makeTempDir("atlas-site-empty-");
    await expect(loadSiteData(fixtureEnv(emptyDir))).rejects.toThrow(/ATLAS_SITE_CHAIN_DIR/);
  });
});
