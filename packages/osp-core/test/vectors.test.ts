import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decodePublicKey } from "../src/encoding/base64url.js";
import { verifyRecords, type ChainRule } from "../src/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = resolve(testDir, "../../../spec/osp/vectors");

const CHAIN_RULES: readonly ChainRule[] = [
  "bad_soul_sig",
  "broken_prev_link",
  "seq_gap",
  "schema_violation",
  "missing_cosigner",
  "forked_head",
  "bad_genesis",
  "bad_drift_evidence"
];

type VectorFile = {
  description: string;
  expected: "valid" | ChainRule;
  soulPublicKey: string;
  doorPublicKeys: string[];
  records: unknown[];
};

/** Type guard for stable ChainRule identifiers. */
function isChainRule(value: string): value is ChainRule {
  return CHAIN_RULES.some((rule) => rule === value);
}

/** Parse and validate one committed conformance vector JSON object. */
function parseVectorFile(raw: string, filename: string): VectorFile {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${filename}: vector root must be an object`);
  }

  const description = Reflect.get(parsed, "description");
  const expected = Reflect.get(parsed, "expected");
  const soulPublicKey = Reflect.get(parsed, "soulPublicKey");
  const doorPublicKeys = Reflect.get(parsed, "doorPublicKeys");
  const records = Reflect.get(parsed, "records");

  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`${filename}: description must be a non-empty string`);
  }
  if (typeof soulPublicKey !== "string") {
    throw new Error(`${filename}: soulPublicKey must be a string`);
  }
  if (!Array.isArray(doorPublicKeys) || !doorPublicKeys.every((key) => typeof key === "string")) {
    throw new Error(`${filename}: doorPublicKeys must be an array of strings`);
  }
  if (!Array.isArray(records)) {
    throw new Error(`${filename}: records must be an array`);
  }

  if (expected === "valid") {
    return {
      description,
      expected: "valid",
      soulPublicKey,
      doorPublicKeys,
      records
    };
  }

  if (typeof expected !== "string" || !isChainRule(expected)) {
    throw new Error(`${filename}: expected must be "valid" or a ChainRule`);
  }

  return {
    description,
    expected,
    soulPublicKey,
    doorPublicKeys,
    records
  };
}

/** Load and parse one committed conformance vector JSON file. */
async function loadVector(filename: string): Promise<VectorFile> {
  const raw = await readFile(join(vectorsDir, filename), "utf8");
  return parseVectorFile(raw, filename);
}

/** Discover all vector JSON files (excludes README). */
async function listVectorFiles(): Promise<string[]> {
  const entries = await readdir(vectorsDir);
  return entries.filter((name) => name.endsWith(".json")).sort();
}

describe("conformance vectors", () => {
  it("runs every committed vector under spec/osp/vectors", async () => {
    const files = await listVectorFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const filename of files) {
      const vector = await loadVector(filename);

      decodePublicKey(vector.soulPublicKey);
      const doorPublicKeys = vector.doorPublicKeys.map((encoded) => decodePublicKey(encoded));

      const result = await verifyRecords(vector.records, { doorPublicKeys });

      if (vector.expected === "valid") {
        expect(result.valid, `${filename}: ${vector.description}`).toBe(true);
        continue;
      }

      expect(result.valid, `${filename}: ${vector.description}`).toBe(false);
      if (result.valid) {
        continue;
      }

      const matched = result.failures.some((failure) => failure.rule === vector.expected);
      expect(
        matched,
        `${filename}: expected rule ${vector.expected}, got ${result.failures.map((f) => f.rule).join(", ")}`
      ).toBe(true);
    }
  });
});
