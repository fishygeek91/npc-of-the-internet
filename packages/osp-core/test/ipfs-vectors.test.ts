import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { decodePublicKey } from "../src/encoding/base64url.js";
import { IpfsSoulStore, verifyChain } from "../src/index.js";
import type { OspRecord } from "../src/schemas/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const vectorsDir = resolve(testDir, "../../../spec/osp/vectors");

type VectorFile = {
  description: string;
  expected: "valid" | string;
  soulPublicKey: string;
  doorPublicKeys: Record<string, string>;
  records: OspRecord[];
};

/** Load and parse one committed conformance vector JSON file. */
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

/** Discover all vector JSON files. */
async function listVectorFiles(): Promise<string[]> {
  const entries = await readdir(vectorsDir);
  return entries.filter((name) => name.endsWith(".json")).sort();
}

describe("IpfsSoulStore vectors", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-ipfs-vectors-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads every valid vector through IpfsSoulStore and verifyChain", async () => {
    const files = await listVectorFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const filename of files) {
      const vector = await loadVector(filename);
      if (vector.expected !== "valid") {
        continue;
      }

      decodePublicKey(vector.soulPublicKey);
      const doorPublicKeys: Record<string, Uint8Array> = {};
      for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
        doorPublicKeys[doorId] = decodePublicKey(encoded);
      }

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

      await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "osp-ipfs-vectors-"));
    }
  });
});
