import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  DualSoulStore,
  FileSoulStore,
  IpfsSoulStore,
  createRecord,
  generateKeypair,
  encodePublicKey,
  CorruptionError,
  type Ed25519Keypair,
  type OspRecord
} from "../src/index.js";

const RESIDENCY = "door:discord:g/epoch:1";

/** Create a unique temporary directory for an isolated store. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "osp-dual-soulstore-"));
}

/** Build and return a signed genesis record for the given soul keypair. */
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

/** Build a signed memory candidate record. */
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

/** Collect all records from an async iterate() call. */
async function collectRecords(store: DualSoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

describe("DualSoulStore", () => {
  let rootDir: string;
  let fileDir: string;
  let ipfsDir: string;
  let soul: Ed25519Keypair;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    fileDir = path.join(rootDir, "file");
    ipfsDir = path.join(rootDir, "ipfs");
    soul = generateKeypair();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("append writes to both stores with matching heads", async () => {
    const store = await DualSoulStore.open(fileDir, ipfsDir);
    try {
      const { record: genesisRecord } = await createGenesisRecord(soul);
      const genesis = await store.append(genesisRecord);
      expect(await store.head()).toEqual({ cid: genesis.cid, seq: 0 });

      const memory = await createMemoryCandidateRecord(soul, 1, genesis.cid, "Dual write.");
      const appendOne = await store.append(memory.record);
      expect(await store.head()).toEqual({ cid: appendOne.cid, seq: 1 });

      const fileStore = await FileSoulStore.open(fileDir);
      const ipfsStore = await IpfsSoulStore.open(ipfsDir);
      try {
        expect(await fileStore.head()).toEqual(await ipfsStore.head());
        expect(await collectRecords(store)).toHaveLength(2);
      } finally {
        await fileStore.close();
        await ipfsStore.close();
      }
    } finally {
      await store.close();
    }
  });

  it("open throws when both stores are non-empty with divergent heads", async () => {
    const fileStore = await FileSoulStore.open(fileDir);
    try {
      const { record } = await createGenesisRecord(soul);
      await fileStore.append(record);
    } finally {
      await fileStore.close();
    }

    const ipfsStore = await IpfsSoulStore.open(ipfsDir);
    try {
      const otherSoul = generateKeypair();
      const { record } = await createGenesisRecord(otherSoul);
      await ipfsStore.append(record);
    } finally {
      await ipfsStore.close();
    }

    await expect(DualSoulStore.open(fileDir, ipfsDir)).rejects.toThrow(CorruptionError);
    await expect(DualSoulStore.open(fileDir, ipfsDir)).rejects.toThrow(
      /dual-write head divergence/
    );
  });

  it("allows open when one store is empty", async () => {
    const fileStore = await FileSoulStore.open(fileDir);
    try {
      const { record } = await createGenesisRecord(soul);
      await fileStore.append(record);
    } finally {
      await fileStore.close();
    }

    const dual = await DualSoulStore.open(fileDir, ipfsDir);
    try {
      const head = await dual.head();
      expect(head?.seq).toBe(0);
    } finally {
      await dual.close();
    }
  });
});
