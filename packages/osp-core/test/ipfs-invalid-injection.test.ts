import { closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { canonicalize, computeCid, CorruptionError, IpfsSoulStore } from "../src/index.js";
import type { OspRecord } from "../src/schemas/index.js";
import { writeHeadAtomic } from "../src/store/head-file.js";
import { fsyncDirectory, fsyncPath, writeAllSync } from "../src/store/fsync.js";
import { resolveBlockPath } from "../src/store/ipfs-soul-store.js";
import { decodePublicKey } from "../src/encoding/base64url.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = resolve(testDir, "../../../spec/osp/vectors");

type VectorFile = {
  description: string;
  expected: "valid" | string;
  soulPublicKey: string;
  doorPublicKeys: Record<string, string>;
  records: OspRecord[];
};

/**
 * Vectors whose failure mode is schema-only at append time and do not represent
 * an injectable on-disk chain layout worth asserting here.
 */
const SKIP_VECTORS = new Set([
  // Schema shape violations — openReadOnly rejects at RecordSchema before chain walk.
  "schema-bad-candidate-cid.json",
  "schema-bad-evidence.json",
  "schema-bad-key-length.json",
  "schema-bad-prev.json",
  "schema-bad-residency.json",
  "schema-dag-json-reserved.json",
  "schema-door-id-mismatch.json",
  "schema-epoch-mismatch.json",
  "schema-genesis-cosigners.json",
  "schema-rejected-with-payload.json",
  "schema-unsorted-cosigners.json",
  "schema-violation.json",
  // Quarantine transitions are runtime state-machine rules, not chain-structure injection.
  "quarantine-candidate-to-rejected.json",
  "quarantine-candidate-to-shard.json"
]);

async function loadVector(filename: string): Promise<VectorFile> {
  const raw = await readFile(join(vectorsDir, filename), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${filename}: vector root must be an object`);
  }

  const description = Reflect.get(parsed, "description");
  const expected = Reflect.get(parsed, "expected");
  const soulPublicKey = Reflect.get(parsed, "soulPublicKey");
  const doorPublicKeys = Reflect.get(parsed, "doorPublicKeys");
  const records = Reflect.get(parsed, "records");

  if (typeof description !== "string") {
    throw new Error(`${filename}: description must be a string`);
  }
  if (typeof expected !== "string") {
    throw new Error(`${filename}: expected must be a string`);
  }
  if (typeof soulPublicKey !== "string") {
    throw new Error(`${filename}: soulPublicKey must be a string`);
  }
  if (typeof doorPublicKeys !== "object" || doorPublicKeys === null) {
    throw new Error(`${filename}: doorPublicKeys must be an object`);
  }
  if (!Array.isArray(records)) {
    throw new Error(`${filename}: records must be an array`);
  }

  return {
    description,
    expected,
    soulPublicKey,
    doorPublicKeys: doorPublicKeys as Record<string, string>,
    records: records as OspRecord[]
  };
}

async function listVectorFiles(): Promise<string[]> {
  const entries = await readdir(vectorsDir);
  return entries.filter((name) => name.endsWith(".json")).sort();
}

/** Write opaque canonical bytes to the IpfsSoulStore blocks layout. */
async function writeBlockFile(blocksPath: string, cid: string, bytes: Uint8Array): Promise<void> {
  const blockPath = resolveBlockPath(blocksPath, cid);
  mkdirSync(dirname(blockPath), { recursive: true });

  const fd = openSync(blockPath, "w");

  try {
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  await fsyncPath(blockPath);
  await fsyncDirectory(dirname(blockPath));
  await fsyncDirectory(blocksPath);
}

/**
 * Inject vector records into blocks + seq-index + HEAD without using append().
 */
async function injectVectorLayout(dir: string, records: OspRecord[]): Promise<void> {
  const blocksPath = join(dir, "blocks");
  mkdirSync(blocksPath, { recursive: true });

  const cids: string[] = [];
  for (const record of records) {
    const bytes = canonicalize(record);
    const cid = await computeCid(record);
    await writeBlockFile(blocksPath, cid, bytes);
    cids.push(cid);
  }

  const indexPath = join(dir, "seq-index.jsonl");
  const indexLines = records
    .map((record, index) => `${JSON.stringify({ seq: record.seq, cid: cids[index] })}\n`)
    .join("");
  await writeFile(indexPath, indexLines);

  const lastRecord = records[records.length - 1];
  const lastCid = cids[cids.length - 1];
  if (lastRecord === undefined || lastCid === undefined) {
    throw new Error("vector has no records");
  }

  await writeHeadAtomic(dir, { cid: lastCid, seq: lastRecord.seq });
}

describe("IpfsSoulStore invalid vector injection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-ipfs-invalid-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects injected invalid vectors on openReadOnly or verifyChain", async () => {
    const files = await listVectorFiles();
    const invalidFiles = files.filter((filename) => !SKIP_VECTORS.has(filename));
    expect(invalidFiles.length).toBeGreaterThan(0);

    let exercised = 0;

    for (const filename of invalidFiles) {
      const vector = await loadVector(filename);
      if (vector.expected === "valid") {
        continue;
      }

      decodePublicKey(vector.soulPublicKey);
      const doorPublicKeys: Record<string, Uint8Array> = {};
      for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
        doorPublicKeys[doorId] = decodePublicKey(encoded);
      }

      await injectVectorLayout(dir, vector.records);

      await expect(IpfsSoulStore.openReadOnly(dir, { doorPublicKeys })).rejects.toThrow(
        CorruptionError
      );

      exercised += 1;
      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "osp-ipfs-invalid-"));
    }

    expect(exercised).toBeGreaterThanOrEqual(5);
  });
});
