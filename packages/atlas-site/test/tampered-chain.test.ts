import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize, computeCidFromCanonicalBytes } from "@npc/osp-core";
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

/**
 * Flip one character in a base64url signature so verification fails while the
 * envelope remains schema-valid. Rewrites chain line + blob under the new CID.
 */
async function tamperMidChainSignature(copyDir: string): Promise<number> {
  const chainPath = join(copyDir, "chain.jsonl");
  const chainText = await readFile(chainPath, "utf8");
  const lines = chainText.split("\n").filter((line) => line.length > 0);
  const midIndex = 1;
  const midLine = lines[midIndex];
  if (midLine === undefined || lines.length < 3) {
    throw new Error("fixture chain too short for mid-chain signature tamper");
  }

  const record = JSON.parse(midLine) as { sig: string; seq: number };
  const sig = record.sig;
  if (sig.length < 2) {
    throw new Error("sig too short to tamper");
  }
  const last = sig[sig.length - 1];
  const flipped = last === "A" ? "B" : "A";
  record.sig = `${sig.slice(0, -1)}${flipped}`;

  const tamperedBytes = canonicalize(record);
  const tamperedCid = await computeCidFromCanonicalBytes(tamperedBytes);
  await writeFile(join(copyDir, "blobs", tamperedCid), tamperedBytes);
  lines[midIndex] = new TextDecoder().decode(tamperedBytes);
  await writeFile(chainPath, `${lines.join("\n")}\n`);
  return record.seq;
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

  it("splits verification badges at the mid-chain failure seq after signature tamper", async () => {
    const copyDir = await makeTempDir("atlas-site-mid-tamper-");
    await cp(MULTI_RESIDENCY_FIXTURE_DIR, copyDir, { recursive: true });
    const failureSeq = await tamperMidChainSignature(copyDir);

    const data = await loadSiteData({ ATLAS_SITE_CHAIN_DIR: copyDir });
    expect(data.chainVerified).toBe(false);

    for (const record of data.records) {
      if (record.seq < failureSeq) {
        expect(record.verified).toBe(true);
      } else {
        expect(record.verified).toBe(false);
      }
    }
  });
});
