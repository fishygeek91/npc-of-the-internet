import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ed from "@noble/ed25519";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import {
  decodeBase64Url,
  decodePublicKey,
  decodeSignature,
  encodeBase64Url
} from "../src/encoding/base64url.js";
import {
  canonicalize,
  cidMatchesHash,
  computeCid,
  CorruptionError,
  FileSoulStore,
  soulPayload,
  verifyRecords,
  type ChainRule,
  type OspRecord
} from "../src/index.js";
import { EXACT_FAILURE_RULES, exactFailureRules } from "./exact-failure-rules.js";

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
  "bad_tombstone",
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
function loadVector(filename: string): VectorFile {
  const raw = readFileSync(join(vectorsDir, filename), "utf8");
  return parseVectorFile(raw, filename);
}

/** Discover all vector JSON files (excludes README). */
function listVectorFiles(): string[] {
  const entries = readdirSync(vectorsDir);
  return entries.filter((name) => name.endsWith(".json")).sort();
}

const loadedVectors = listVectorFiles().map((filename) => ({
  filename,
  vector: loadVector(filename)
}));

describe("conformance vectors", () => {
  it("pins a rule list for every negative vector and no other file", () => {
    const negative = loadedVectors
      .filter((entry) => entry.vector.expected !== "valid")
      .map((entry) => entry.filename)
      .sort();
    expect(Object.keys(EXACT_FAILURE_RULES).sort()).toEqual(negative);
    for (const entry of loadedVectors) {
      if (entry.vector.expected === "valid") {
        continue;
      }
      expect(exactFailureRules(entry.filename)[0], entry.filename).toBe(entry.vector.expected);
    }
  });

  it.each(loadedVectors.map((entry) => [entry.filename, entry.vector] as const))(
    "%s",
    async (filename, vector) => {
      decodePublicKey(vector.soulPublicKey);
      const doorPublicKeys: Record<string, Uint8Array> = {};
      for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
        doorPublicKeys[doorId] = decodePublicKey(encoded);
      }

      if (vector.blobs !== undefined) {
        await assertBlobsMapConsistent(filename, vector.records, vector.blobs);
      }

      const result = await verifyRecords(vector.records, { doorPublicKeys });
      const label = `${filename}: ${vector.description}`;

      if (vector.expected === "valid") {
        expect(result.valid, label).toBe(true);
        return;
      }

      expect(result.valid, label).toBe(false);
      if (result.valid) {
        return;
      }

      const rules = result.failures.map((failure) => failure.rule);
      expect(rules[0], label).toBe(vector.expected);
      expect(rules, label).toEqual([...exactFailureRules(filename)]);
    }
  );
});

describe("strict RFC 8032 vector (small-order soul key)", () => {
  const filename = "bad-soul-sig-small-order-key.json";

  it("fails every record with bad_soul_sig only, although ZIP-215 would accept each signature", async () => {
    const vector = loadVector(filename);
    const doorPublicKeys: Record<string, Uint8Array> = {};
    for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
      doorPublicKeys[doorId] = decodePublicKey(encoded);
    }

    const result = await verifyRecords(vector.records, { doorPublicKeys });
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.failures.map((failure) => failure.rule)).toEqual(
      vector.records.map(() => "bad_soul_sig")
    );

    // The vector is meaningful: under noble's ZIP-215 default every signature "verifies".
    const soulKey = decodePublicKey(vector.soulPublicKey);
    for (const record of vector.records as OspRecord[]) {
      const message = canonicalize(soulPayload(record));
      const sig = decodeSignature(record.sig);
      expect(ed.verify(sig, message, soulKey, { zip215: true })).toBe(true);
      expect(ed.verify(sig, message, soulKey, { zip215: false })).toBe(false);
    }
  });

  it("is refused by FileSoulStore when injected on disk and on append", async () => {
    const vector = loadVector(filename);
    const records = vector.records as OspRecord[];
    const doorPublicKeys: Record<string, Uint8Array> = {};
    for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
      doorPublicKeys[doorId] = decodePublicKey(encoded);
    }

    const dir = await mkdtemp(join(tmpdir(), "osp-vector-small-order-"));
    try {
      const injected = join(dir, "injected");
      await mkdir(join(injected, "blobs"), { recursive: true });
      const lines: Buffer[] = [];
      for (const record of records) {
        const bytes = canonicalize(record);
        await writeFile(join(injected, "blobs", await computeCid(record)), bytes);
        lines.push(Buffer.from(bytes), Buffer.from("\n"));
      }
      await writeFile(join(injected, "chain.jsonl"), Buffer.concat(lines));

      await expect(FileSoulStore.open(injected, { doorPublicKeys })).rejects.toThrow(
        CorruptionError
      );
      const readOnly = await FileSoulStore.openReadOnly(injected, { doorPublicKeys });
      try {
        const verification = readOnly.verification();
        expect(verification.valid).toBe(false);
        if (!verification.valid) {
          expect(verification.failures.map((failure) => failure.rule)).toEqual([
            ...exactFailureRules(filename)
          ]);
        }
      } finally {
        await readOnly.close();
      }

      const fresh = await FileSoulStore.open(join(dir, "fresh"), { doorPublicKeys });
      try {
        const genesis = records[0];
        if (genesis === undefined) {
          throw new Error("vector has no records");
        }
        await expect(fresh.append(genesis)).rejects.toThrow();
        expect(await fresh.head()).toBeNull();
      } finally {
        await fresh.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
