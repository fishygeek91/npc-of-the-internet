import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canonicalize, computeCid, CorruptionError, IpfsSoulStore } from "../src/index.js";
import type { OspRecord } from "../src/schemas/index.js";
import { writeHeadAtomic } from "../src/store/head-file.js";
import { resolveBlockPath } from "../src/store/ipfs-soul-store.js";
import { decodePublicKey } from "../src/encoding/base64url.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = resolve(testDir, "../../../spec/osp/vectors");

/**
 * Retry directory removal. A timed-out run can still hold a block file, and
 * Node then fails the cleanup with ENOTEMPTY / EBUSY.
 */
const REMOVE_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 20 } as const;

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
  // Own "__proto__" key cannot be canonicalized for block injection (rejected at parse).
  "schema-proto-key.json",
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

/**
 * One case per injectable vector. The old single `it` fsynced every fixture
 * block and then opened a store, and under a parallel osp-core run that one
 * test sat at ~4.9s against Vitest's 5s timeout. Fixture bytes are visible to
 * this process once `writeFile` closes them; fsync only waits for crash
 * durability, which this rejection check does not need. `writeHeadAtomic`
 * still fsyncs HEAD, matching the on-disk layout openReadOnly reads.
 */
const vectors = loadVectors(vectorsDir);
const filenames = [...vectors.keys()];
const notSkipped = filenames.filter((filename) => !SKIP_VECTORS.has(filename));
const injectable = notSkipped.filter((filename) => vectors.get(filename)?.expected !== "valid");

function parseVector(filename: string, raw: string): VectorFile {
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

/** Read every vector once so each test does not re-parse the suite. */
function loadVectors(dir: string): Map<string, VectorFile> {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const loaded = new Map<string, VectorFile>();
  for (const filename of names) {
    loaded.set(filename, parseVector(filename, readFileSync(join(dir, filename), "utf8")));
  }
  return loaded;
}

/** Door public keys for one vector, decoded the same way openReadOnly expects. */
function doorKeys(vector: VectorFile): Record<string, Uint8Array> {
  const doorPublicKeys: Record<string, Uint8Array> = {};
  for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
    doorPublicKeys[doorId] = decodePublicKey(encoded);
  }
  return doorPublicKeys;
}

/**
 * Write one block into the sharded layout. No fsync: the following
 * `openReadOnly` runs in this process and observes the closed write.
 */
async function writeBlockFile(blocksPath: string, cid: string, bytes: Uint8Array): Promise<void> {
  const blockPath = resolveBlockPath(blocksPath, cid);
  await mkdir(dirname(blockPath), { recursive: true });
  await writeFile(blockPath, bytes);
}

/**
 * Inject vector records into blocks + seq-index + HEAD without using append().
 */
async function injectVectorLayout(dir: string, records: OspRecord[]): Promise<void> {
  const blocksPath = join(dir, "blocks");
  await mkdir(blocksPath, { recursive: true });

  const cids: string[] = [];
  for (const record of records) {
    const bytes = canonicalize(record);
    const cid = await computeCid(record);
    await writeBlockFile(blocksPath, cid, bytes);
    cids.push(cid);
  }

  const indexLines: string[] = [];
  for (const [index, record] of records.entries()) {
    const cid = cids[index];
    if (cid === undefined) {
      throw new Error(`missing block cid at index ${String(index)}`);
    }
    indexLines.push(`${JSON.stringify({ seq: record.seq, cid })}\n`);
  }
  await writeFile(join(dir, "seq-index.jsonl"), indexLines.join(""));

  const lastIndex = records.length - 1;
  const lastRecord = records[lastIndex];
  const lastCid = cids[lastIndex];
  if (lastRecord === undefined || lastCid === undefined) {
    throw new Error("vector has no records");
  }

  await writeHeadAtomic(dir, { cid: lastCid, seq: lastRecord.seq });
}

describe("IpfsSoulStore invalid vector injection", () => {
  it("selects a meaningful set of injectable invalid vectors", () => {
    expect(notSkipped.length).toBeGreaterThan(0);
    expect(injectable.length).toBeGreaterThanOrEqual(5);
  });

  it.each(injectable)("rejects injected %s on openReadOnly", async (filename) => {
    const vector = vectors.get(filename);
    if (vector === undefined) {
      throw new Error(`missing vector ${filename}`);
    }

    decodePublicKey(vector.soulPublicKey);
    const doorPublicKeys = doorKeys(vector);
    const dir = await mkdtemp(join(tmpdir(), "osp-ipfs-invalid-"));
    try {
      await injectVectorLayout(dir, vector.records);
      await expect(IpfsSoulStore.openReadOnly(dir, { doorPublicKeys })).rejects.toThrow(
        CorruptionError
      );
    } finally {
      await rm(dir, REMOVE_TREE);
    }
  });
});
