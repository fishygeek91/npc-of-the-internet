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
      status: "traveling",
      door_id: null,
      epoch: 3,
      since: "2026-01-04T05:03:00.000Z",
      verified: true
    });
    expect(data.chainVerified).toBe(true);
    expect(
      data.residencies.map((entry) => [entry.door_id, entry.epoch, entry.traveled_to])
    ).toEqual([
      ["web:home", 3, "discord:g"],
      ["irc:libera-wanderer", 2, "web:home"],
      ["discord:g", 1, "irc:libera-wanderer"]
    ]);
    expect(data.residencies[0]).toMatchObject({
      counts: { witnessed: 1, declined: 1, screened: 1 },
      declined_reasons: ["private"],
      journal: { journal: "JOURNAL_EPOCH_3" }
    });
    expect(data.journals.map((entry) => entry.journal)).toEqual([
      "JOURNAL_EPOCH_3",
      "JOURNAL_EPOCH_2",
      "JOURNAL_EPOCH_1"
    ]);
    expect(data.journals[0]?.cid).toBe(data.residencies[0]?.journal?.cid);
    expect(data.totalRecords).toBe(19);
    expect(data.recordsPages).toHaveLength(4);
    expect(data.recordsPages[0]?.per_page).toBe(5);
    expect(data.recordsPages[0]?.records).toHaveLength(5);
    expect(data.recordsPages[3]?.records).toHaveLength(4);
    expect(data.records).toHaveLength(19);
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
