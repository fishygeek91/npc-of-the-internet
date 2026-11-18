import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize, computeCid } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadSiteData } from "../src/lib/load-site-data.js";
import { deriveRecordsPageView, soulListPath } from "../src/lib/pagination.js";

const MULTI_RESIDENCY_FIXTURE_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "atlas",
  "test",
  "fixtures",
  "multi-residency"
);

/** Committed chain: shard, then a tombstone of that shard's text blob. */
const TOMBSTONE_VECTOR_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "spec",
  "osp",
  "vectors",
  "valid-tombstone-after-shard.json"
);

const tombstoneVectorSchema = z.object({
  expected: z.literal("valid"),
  doorPublicKeys: z.record(z.string(), z.string().min(1)),
  records: z.array(z.unknown()).min(1)
});

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

/**
 * Write `valid-tombstone-after-shard.json` as a read-only soulchain directory.
 * Each chain line is canonical bytes, and the same bytes are stored at `blobs/<cid>`,
 * which is what `FileSoulStore.openReadOnly` checks before the site can load the chain.
 */
async function materializeTombstoneVector(): Promise<string> {
  const raw = await readFile(TOMBSTONE_VECTOR_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const vector = tombstoneVectorSchema.parse(parsed);
  const dir = await makeTempDir("atlas-site-tombstone-");
  await mkdir(join(dir, "blobs"));

  const lines: Uint8Array[] = [];
  const newline = new TextEncoder().encode("\n");
  for (const record of vector.records) {
    const bytes = canonicalize(record);
    const cid = await computeCid(record);
    await writeFile(join(dir, "blobs", cid), bytes);
    lines.push(bytes, newline);
  }

  await writeFile(join(dir, "chain.jsonl"), Buffer.concat(lines));
  await writeFile(
    join(dir, "fixture-meta.json"),
    `${JSON.stringify({ doorPublicKeys: vector.doorPublicKeys }, null, 2)}\n`
  );
  return dir;
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

  it("shows a tombstone chip and a body-free /soul/type/tombstone/ view", async () => {
    const chainDir = await materializeTombstoneVector();
    const data = await loadSiteData(fixtureEnv(chainDir));

    expect(data.chainVerified).toBe(true);
    expect(data.totalRecords).toBe(4);
    expect(data.recordTypes).toEqual(["genesis", "memory", "attestation", "tombstone"]);
    expect(soulListPath(1, "tombstone")).toBe("/soul/type/tombstone/");

    const tombstone = data.records.find((record) => record.type === "tombstone");
    if (tombstone === undefined) {
      throw new Error("expected the vector chain to include a tombstone record");
    }

    expect(tombstone.seq).toBe(3);
    expect(tombstone.kind).toBe("tombstone");
    expect(tombstone.issued_at).toBe("2026-01-03T00:00:00.000Z");
    expect(tombstone.displayBodyJson).toContain("blob_cid");
    expect(tombstone.displayBodyJson).toContain("target_cid");
    expect(tombstone.displayBodyJson).toContain("erasure_request");

    const view = deriveRecordsPageView(data.records, data.chainVerified, { type: "tombstone" });
    expect(view).toEqual({
      records: [
        {
          cid: tombstone.cid,
          seq: 3,
          kind: "tombstone",
          issued_at: "2026-01-03T00:00:00.000Z",
          summary: "tombstone"
        }
      ],
      page: 1,
      per_page: 5,
      total: 1,
      verified: true
    });

    const listing = view.records[0];
    if (listing === undefined) {
      throw new Error("expected the tombstone type page to list the tombstone record");
    }
    expect(Object.keys(listing).sort()).toEqual(["cid", "issued_at", "kind", "seq", "summary"]);
    expect(listing.summary).toBe(listing.kind);

    const viewJson = JSON.stringify(view);
    expect(viewJson).not.toContain("blob_cid");
    expect(viewJson).not.toContain("target_cid");
    expect(viewJson).not.toContain("text_cid");
    expect(viewJson).not.toContain("erasure_request");
    expect(viewJson).not.toContain("displayBody");
  });

  it("throws when ATLAS_SITE_CHAIN_DIR is missing", async () => {
    await expect(loadSiteData({})).rejects.toThrow(/ATLAS_SITE_CHAIN_DIR/);
  });

  it("throws when ATLAS_SITE_CHAIN_DIR does not contain chain.jsonl", async () => {
    const emptyDir = await makeTempDir("atlas-site-empty-");
    await expect(loadSiteData(fixtureEnv(emptyDir))).rejects.toThrow(/ATLAS_SITE_CHAIN_DIR/);
  });
});
