import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildAndSignPinManifestForIpfsDir,
  computeCid,
  computeCidFromCanonicalBytes,
  CorruptionError,
  createRecord,
  encodePublicKey,
  exportSoulchainCar,
  generateKeypair,
  importSoulchainCar,
  IpfsSoulStore,
  listRecordCidsFromIpfsDir,
  verifyChain,
  type Ed25519Keypair
} from "../src/index.js";
import { resolveBlockPath } from "../src/store/ipfs-soul-store.js";
import { readFile } from "node:fs/promises";

const RESIDENCY = "door:discord:g/epoch:1";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function createGenesisRecord(soul: Ed25519Keypair) {
  return createRecord({
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

async function createMemoryCandidateRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string
) {
  return createRecord({
    seq,
    prev,
    type: "memory",
    body: {
      kind: "candidate",
      text,
      proposed_at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

describe("soulchain CAR round-trip", () => {
  let sourceDir: string;
  let soul: Ed25519Keypair;

  beforeEach(async () => {
    sourceDir = await makeTempDir("osp-car-source-");
    soul = generateKeypair();
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("exports and imports with identical CIDs and verifyChain green", async () => {
    const store = await IpfsSoulStore.open(sourceDir);
    const genesis = await createGenesisRecord(soul);
    await store.append(genesis.record);

    const memory = await createMemoryCandidateRecord(
      soul,
      1,
      genesis.cid,
      "A shard of conversation."
    );
    await store.append(memory.record);
    await store.close();

    const manifest = await buildAndSignPinManifestForIpfsDir(sourceDir, soul.privateKey, {
      generatedAt: "2026-07-28T00:00:00Z"
    });

    const carPath = path.join(sourceDir, "soulchain.car");
    await exportSoulchainCar({
      ipfsDir: sourceDir,
      manifest,
      outPath: carPath
    });

    const importDir = await makeTempDir("osp-car-import-");
    try {
      const imported = await importSoulchainCar({
        carPathOrBytes: carPath,
        outDir: importDir
      });

      expect(imported.headCid).toBe(memory.cid);
      expect(imported.seq).toBe(1);

      const reopened = await IpfsSoulStore.openReadOnly(importDir);
      try {
        const verifyResult = await verifyChain(reopened);
        expect(verifyResult.valid).toBe(true);

        const sourceCids = await listRecordCidsFromIpfsDir(sourceDir);
        const importedCids = await listRecordCidsFromIpfsDir(importDir);
        expect(importedCids).toEqual(sourceCids);

        for (const cid of sourceCids) {
          const sourceBytes = await readFile(resolveBlockPath(path.join(sourceDir, "blocks"), cid));
          const importedBytes = await readFile(
            resolveBlockPath(path.join(importDir, "blocks"), cid)
          );
          expect(importedBytes).toEqual(sourceBytes);
          expect(await computeCidFromCanonicalBytes(importedBytes)).toBe(cid);
        }

        for await (const record of reopened.iterate()) {
          expect(await computeCid(record)).toBe(importedCids[record.seq]);
        }
      } finally {
        await reopened.close();
      }

      expect(imported.manifestCid).toBeTruthy();
    } finally {
      await rm(importDir, { recursive: true, force: true });
    }
  });

  it("rejects import when expectedManifestCid does not match CAR root", async () => {
    const store = await IpfsSoulStore.open(sourceDir);
    const genesis = await createGenesisRecord(soul);
    await store.append(genesis.record);
    await store.close();

    const manifest = await buildAndSignPinManifestForIpfsDir(sourceDir, soul.privateKey, {
      generatedAt: "2026-07-28T00:00:00Z"
    });

    const carPath = path.join(sourceDir, "soulchain.car");
    await exportSoulchainCar({
      ipfsDir: sourceDir,
      manifest,
      outPath: carPath
    });

    const importDir = await makeTempDir("osp-car-import-bad-manifest-");
    try {
      await expect(
        importSoulchainCar({
          carPathOrBytes: carPath,
          outDir: importDir,
          expectedManifestCid: genesis.cid
        })
      ).rejects.toThrow(CorruptionError);
    } finally {
      await rm(importDir, { recursive: true, force: true });
    }
  });
});
