import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodePublicKey } from "../src/encoding/base64url.js";
import { IpfsSoulStore, verifyChain } from "../src/index.js";
import type { OspRecord } from "../src/schemas/index.js";

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
 * One case per vector. Each {@link IpfsSoulStore.append} fsyncs the block, its
 * shard directory, the blocks directory, the seq-index, and HEAD. Walking every
 * valid vector inside a single `it` summed those syncs to about 4.4–4.9s when
 * the rest of the osp-core suite was also fsyncing, against Vitest's 5s test
 * timeout. There is no Helia node — `open()` itself is a directory check.
 * Per-vector tests keep the same assertions, each with its own timeout budget.
 */
const vectors = loadVectors(vectorsDir);
const filenames = [...vectors.keys()];
const validFilenames = filenames.filter((filename) => vectors.get(filename)?.expected === "valid");

/** Load and parse one committed conformance vector JSON file. */
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

/** Door public keys for one vector, decoded the same way append verification expects. */
function doorKeys(vector: VectorFile): Record<string, Uint8Array> {
  const doorPublicKeys: Record<string, Uint8Array> = {};
  for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
    doorPublicKeys[doorId] = decodePublicKey(encoded);
  }
  return doorPublicKeys;
}

describe("IpfsSoulStore vectors", () => {
  it("discovers committed vector files, including valid chains", () => {
    expect(filenames.length).toBeGreaterThan(0);
    expect(validFilenames.length).toBeGreaterThan(0);
  });

  it.each(validFilenames)("loads %s through IpfsSoulStore and verifyChain", async (filename) => {
    const vector = vectors.get(filename);
    if (vector === undefined) {
      throw new Error(`missing vector ${filename}`);
    }

    decodePublicKey(vector.soulPublicKey);
    const doorPublicKeys = doorKeys(vector);
    const dir = await mkdtemp(join(tmpdir(), "osp-ipfs-vectors-"));
    try {
      const store = await IpfsSoulStore.open(dir, { doorPublicKeys });
      try {
        for (const record of vector.records) {
          await store.append(record);
        }

        const result = await verifyChain(store, { doorPublicKeys });
        expect(result.valid, `${filename}: ${vector.description}`).toBe(true);
      } finally {
        await store.close();
      }
    } finally {
      await rm(dir, REMOVE_TREE);
    }
  });
});
