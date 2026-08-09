import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import { decodeBase64Url, decodePublicKey, encodeBase64Url } from "../src/encoding/base64url.js";
import { cidMatchesHash, verifyRecords, type ChainRule } from "../src/index.js";

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
  "bad_drift_evidence",
  "bad_session_continuity",
  "presence_conflict"
];

type VectorFile = {
  description: string;
  expected: "valid" | ChainRule;
  soulPublicKey: string;
  doorPublicKeys: Record<string, string>;
  records: unknown[];
  /** Optional side-blob map (CID → base64url bytes) for osp/0.2 vectors. */
  blobs?: Record<string, string>;
};

/** Type guard for stable ChainRule identifiers. */
function isChainRule(value: string): value is ChainRule {
  return CHAIN_RULES.some((rule) => rule === value);
}

/** Collect text_hash / journal_hash values referenced by memory bodies in the vector. */
function collectBodyContentHashes(records: readonly unknown[]): Set<string> {
  const hashes = new Set<string>();
  for (const record of records) {
    if (typeof record !== "object" || record === null) {
      continue;
    }
    const type = Reflect.get(record, "type");
    const body = Reflect.get(record, "body");
    if (type !== "memory" || typeof body !== "object" || body === null) {
      continue;
    }
    const textHash = Reflect.get(body, "text_hash");
    if (typeof textHash === "string") {
      hashes.add(textHash);
    }
    const journalHash = Reflect.get(body, "journal_hash");
    if (typeof journalHash === "string") {
      hashes.add(journalHash);
    }
  }
  return hashes;
}

/**
 * Assert each side-blob entry's CID multihash and content hash match sha256(bytes),
 * and that the content hash appears on at least one memory body in the vector.
 */
async function assertBlobsMapConsistent(
  filename: string,
  records: readonly unknown[],
  blobs: Record<string, string>
): Promise<void> {
  const bodyHashes = collectBodyContentHashes(records);
  expect(
    Object.keys(blobs).length,
    `${filename}: blobs map must be non-empty when present`
  ).toBeGreaterThan(0);

  for (const [cid, encoded] of Object.entries(blobs)) {
    expect(typeof encoded, `${filename}: blob ${cid} value must be a string`).toBe("string");
    const bytes = decodeBase64Url(encoded);
    const digest = await sha256.digest(bytes);
    const hash = encodeBase64Url(digest.digest);
    expect(
      cidMatchesHash(cid, hash),
      `${filename}: blob CID ${cid} multihash must match sha256(bytes)`
    ).toBe(true);
    expect(
      bodyHashes.has(hash),
      `${filename}: blob ${cid} hash ${hash} must appear as text_hash or journal_hash on a memory body`
    ).toBe(true);
    // Belt-and-suspenders: CID parse succeeds for committed bagu… strings.
    expect(() => CID.parse(cid)).not.toThrow();
  }
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
  const blobsRaw = Reflect.get(parsed, "blobs");

  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`${filename}: description must be a non-empty string`);
  }
  if (typeof soulPublicKey !== "string") {
    throw new Error(`${filename}: soulPublicKey must be a string`);
  }
  if (
    typeof doorPublicKeys !== "object" ||
    doorPublicKeys === null ||
    Array.isArray(doorPublicKeys)
  ) {
    throw new Error(`${filename}: doorPublicKeys must be an object`);
  }
  for (const [doorId, encoded] of Object.entries(doorPublicKeys)) {
    if (typeof doorId !== "string" || doorId.length === 0) {
      throw new Error(`${filename}: doorPublicKeys keys must be non-empty strings`);
    }
    if (typeof encoded !== "string") {
      throw new Error(`${filename}: doorPublicKeys values must be base64url strings`);
    }
  }
  if (!Array.isArray(records)) {
    throw new Error(`${filename}: records must be an array`);
  }

  let blobs: Record<string, string> | undefined;
  if (blobsRaw !== undefined) {
    if (typeof blobsRaw !== "object" || blobsRaw === null || Array.isArray(blobsRaw)) {
      throw new Error(`${filename}: blobs must be an object when present`);
    }
    blobs = {};
    for (const [cid, encoded] of Object.entries(blobsRaw)) {
      if (typeof encoded !== "string") {
        throw new Error(`${filename}: blobs values must be base64url strings`);
      }
      blobs[cid] = encoded;
    }
  }

  if (expected === "valid") {
    return {
      description,
      expected: "valid",
      soulPublicKey,
      doorPublicKeys,
      records,
      blobs
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
    records,
    blobs
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
      const doorPublicKeys: Record<string, Uint8Array> = {};
      for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
        doorPublicKeys[doorId] = decodePublicKey(encoded);
      }

      if (vector.blobs !== undefined) {
        await assertBlobsMapConsistent(filename, vector.records, vector.blobs);
      }

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
