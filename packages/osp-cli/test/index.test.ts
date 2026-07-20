import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CharterResolutionError, readCharterContents } from "../src/charter.js";
import { formatLogLine } from "../src/log-format.js";
import { defaultCharterPath, findRepoRoot } from "../src/repo-root.js";
import type { OspRecord } from "@npc/osp-core";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

describe("charter resolution", () => {
  it("finds the repository charter from the monorepo root", () => {
    const root = findRepoRoot(repoRoot);
    expect(root).toBe(repoRoot);
    expect(defaultCharterPath(repoRoot)).toBe(path.join(repoRoot, "spec", "osp", "genesis.md"));
  });

  it("rejects an empty charter file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "osp-charter-"));
    const charterFile = path.join(dir, "empty.md");
    writeFileSync(charterFile, "");
    expect(() => readCharterContents(charterFile)).toThrow(CharterResolutionError);
  });
});

describe("log formatting", () => {
  it("formats genesis lines with cid prefix and created_at", () => {
    const record: OspRecord = {
      spec: "osp/0.1",
      seq: 0,
      prev: null,
      type: "genesis",
      body: {
        charter: "# test",
        soul_pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        created_at: "2026-07-20T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      sig: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    };

    const line = formatLogLine(record, "bagu4eraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(line).toBe("0 genesis bagu4eraaaaaa… 2026-07-20T00:00:00.000Z");
  });
});

describe("@npc/osp-cli", () => {
  it("exports its package name", async () => {
    const { packageName } = await import("../src/index.js");
    expect(packageName).toBe("@npc/osp-cli");
  });
});
