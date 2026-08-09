import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  FileSoulStore,
  IpfsSoulStore,
  createRecord,
  generateKeypair,
  encodePublicKey,
  type Ed25519Keypair,
  type OspRecord
} from "../src/index.js";

const RESIDENCY = "door:discord:g/epoch:1";

/** Create a unique temporary directory for an isolated store. */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Collect all records from an async iterate() call. */
async function collectRecords(store: FileSoulStore | IpfsSoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

/** Build and return a signed genesis record. */
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

describe("store CID identity", () => {
  let fileDir: string;
  let ipfsDir: string;
  let soul: Ed25519Keypair;

  beforeEach(async () => {
    fileDir = await makeTempDir("osp-cid-identity-file-");
    ipfsDir = await makeTempDir("osp-cid-identity-ipfs-");
    soul = generateKeypair();
  });

  afterEach(async () => {
    await rm(fileDir, { recursive: true, force: true });
    await rm(ipfsDir, { recursive: true, force: true });
  });

  it("produces identical CIDs and iterate bodies in FileSoulStore and IpfsSoulStore", async () => {
    const fileStore = await FileSoulStore.open(fileDir);
    const ipfsStore = await IpfsSoulStore.open(ipfsDir);

    try {
      const { record: genesisRecord } = await createGenesisRecord(soul);
      const fileGenesis = await fileStore.append(genesisRecord);
      const ipfsGenesis = await ipfsStore.append(genesisRecord);
      expect(ipfsGenesis.cid).toBe(fileGenesis.cid);

      const memoryOne = await createMemoryCandidateRecord(
        soul,
        1,
        fileGenesis.cid,
        "CID identity check one."
      );
      const fileOne = await fileStore.append(memoryOne.record);
      const ipfsOne = await ipfsStore.append(memoryOne.record);
      expect(ipfsOne.cid).toBe(fileOne.cid);

      const memoryTwo = await createMemoryCandidateRecord(
        soul,
        2,
        fileOne.cid,
        "CID identity check two."
      );
      const fileTwo = await fileStore.append(memoryTwo.record);
      const ipfsTwo = await ipfsStore.append(memoryTwo.record);
      expect(ipfsTwo.cid).toBe(fileTwo.cid);

      const fileRecords = await collectRecords(fileStore);
      const ipfsRecords = await collectRecords(ipfsStore);

      expect(fileRecords.map((record) => record.seq)).toEqual([0, 1, 2]);
      expect(ipfsRecords.map((record) => record.seq)).toEqual([0, 1, 2]);

      for (let index = 0; index < fileRecords.length; index += 1) {
        expect(ipfsRecords[index]?.body).toEqual(fileRecords[index]?.body);
        expect(ipfsRecords[index]?.sig).toBe(fileRecords[index]?.sig);
      }
    } finally {
      await fileStore.close();
      await ipfsStore.close();
    }
  });
});
