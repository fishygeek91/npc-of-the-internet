import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  IpfsSoulStore,
  createRecord,
  generateKeypair,
  encodePublicKey,
  canonicalize,
  CorruptionError,
  ChainMismatchError,
  ConcurrentAppendError,
  type OspRecord,
  type Ed25519Keypair
} from "../src/index.js";
import { resolveBlockPath } from "../src/store/ipfs-soul-store.js";
import { appendSeqIndex } from "../src/store/seq-index.js";
import { fsyncPath } from "../src/store/fsync.js";

const RESIDENCY = "door:discord:g/epoch:1";
const WRONG_PREV_CID = "bagu" + "a".repeat(57);
const LOCK_FILE = "LOCK";
const SEQ_INDEX_FILE = "seq-index.jsonl";

/** Create a unique temporary directory for an isolated store. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "osp-ipfs-soulstore-"));
}

/** Collect all records from an async iterate() call. */
async function collectRecords(store: IpfsSoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
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

/** Build a signed memory candidate record (no door cosignature). */
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

/** Append genesis to the store and return the append result. */
async function appendGenesis(store: IpfsSoulStore, soul: Ed25519Keypair) {
  const { record } = await createGenesisRecord(soul);
  return store.append(record);
}

describe("IpfsSoulStore", () => {
  let dir: string;
  let soul: Ed25519Keypair;

  beforeEach(async () => {
    dir = await makeTempDir();
    soul = generateKeypair();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("append / head / get / iterate happy path", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      expect(await store.head()).toBeNull();

      const genesis = await appendGenesis(store, soul);
      const headAfterGenesis = await store.head();
      if (headAfterGenesis === null) {
        throw new Error("expected head after genesis");
      }

      const memoryOne = await createMemoryCandidateRecord(
        soul,
        1,
        headAfterGenesis.cid,
        "First candidate memory."
      );
      const appendOne = await store.append(memoryOne.record);

      const headAfterOne = await store.head();
      if (headAfterOne === null) {
        throw new Error("expected head after first memory");
      }

      const memoryTwo = await createMemoryCandidateRecord(
        soul,
        2,
        headAfterOne.cid,
        "Second candidate memory."
      );
      const appendTwo = await store.append(memoryTwo.record);

      const head = await store.head();
      expect(head).toEqual({ cid: appendTwo.cid, seq: 2 });

      const genesisFetched = await store.get(genesis.cid);
      const oneFetched = await store.get(appendOne.cid);
      const twoFetched = await store.get(appendTwo.cid);

      expect(genesisFetched.seq).toBe(0);
      expect(genesisFetched.type).toBe("genesis");
      expect(oneFetched.body).toEqual(memoryOne.record.body);
      expect(twoFetched.body).toEqual(memoryTwo.record.body);

      const iterated = await collectRecords(store);
      expect(iterated).toHaveLength(3);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1, 2]);
    } finally {
      await store.close();
    }
  });

  it("refuses append when prev does not match head", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);

      const { record } = await createMemoryCandidateRecord(
        soul,
        1,
        WRONG_PREV_CID,
        "Wrong prev link."
      );

      await expect(store.append(record)).rejects.toThrow(ChainMismatchError);
    } finally {
      await store.close();
    }
  });

  it("refuses append when seq has a gap", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      const genesis = await appendGenesis(store, soul);

      const { record } = await createMemoryCandidateRecord(soul, 2, genesis.cid, "Sequence gap.");

      await expect(store.append(record)).rejects.toThrow(ChainMismatchError);
    } finally {
      await store.close();
    }
  });

  it("refuses concurrent append when LOCK is held", async () => {
    const store = await IpfsSoulStore.open(dir);
    const genesis = await appendGenesis(store, soul);

    const lockPath = path.join(dir, LOCK_FILE);
    const lockFd = await fsOpen(lockPath, "wx");

    const { record } = await createMemoryCandidateRecord(
      soul,
      1,
      genesis.cid,
      "Concurrent append test."
    );

    try {
      await expect(store.append(record)).rejects.toThrow(ConcurrentAppendError);
    } finally {
      await lockFd.close();
      await rm(lockPath, { force: true });
      await store.close();
    }
  });

  it("openWithRecovery advances HEAD when block and seq-index exist but HEAD is stale", async () => {
    const store = await IpfsSoulStore.open(dir);
    let memoryCid = "";
    let memoryRecord: OspRecord;
    try {
      const genesis = await appendGenesis(store, soul);
      const memory = await createMemoryCandidateRecord(
        soul,
        1,
        genesis.cid,
        "Crash window recovery."
      );
      memoryRecord = memory.record;
      memoryCid = memory.cid;

      const bytes = canonicalize(memoryRecord);
      const { FsBlockstore } = await import("blockstore-fs");
      const { CID } = await import("multiformats/cid");
      const blockstore = new FsBlockstore(path.join(dir, "blocks"));
      await blockstore.open();
      await blockstore.put(CID.parse(memoryCid), bytes);
      await blockstore.close();

      await appendSeqIndex(path.join(dir, SEQ_INDEX_FILE), { seq: 1, cid: memoryCid });

      // HEAD still points at genesis (simulate crash after block+index, before HEAD update).
      await writeFile(path.join(dir, "HEAD"), `${JSON.stringify({ cid: genesis.cid, seq: 0 })}\n`);
    } finally {
      await store.close();
    }

    const { store: recovered } = await IpfsSoulStore.openWithRecovery(dir);
    try {
      const head = await recovered.head();
      expect(head).toEqual({ cid: memoryCid, seq: 1 });

      const iterated = await collectRecords(recovered);
      expect(iterated).toHaveLength(2);
      expect(iterated[1]?.body).toEqual(memoryRecord.body);
    } finally {
      await recovered.close();
    }
  });

  it("fsyncs the sharded block path after append (path derivation matches on-disk layout)", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      const genesis = await appendGenesis(store, soul);
      const blockPath = resolveBlockPath(path.join(dir, "blocks"), genesis.cid);

      expect(existsSync(blockPath)).toBe(true);
      // Path derivation matches FsBlockstore layout; fsyncPath succeeds on the real file.
      await expect(fsyncPath(blockPath)).resolves.toBeUndefined();

      const relative = path.relative(path.join(dir, "blocks"), blockPath);
      const parts = relative.split(path.sep);
      expect(parts).toHaveLength(2);
      expect(parts[0]?.length).toBe(2);
      expect(parts[1]?.endsWith(".data")).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("reopens cleanly after append round-trip", async () => {
    let genesisCid = "";
    const store = await IpfsSoulStore.open(dir);
    try {
      const genesis = await appendGenesis(store, soul);
      genesisCid = genesis.cid;
      const headAfterGenesis = await store.head();
      if (headAfterGenesis === null) {
        throw new Error("expected head after genesis");
      }

      const memory = await createMemoryCandidateRecord(
        soul,
        1,
        headAfterGenesis.cid,
        "Round-trip check."
      );
      await store.append(memory.record);
    } finally {
      await store.close();
    }

    const reopened = await IpfsSoulStore.open(dir);
    try {
      const iterated = await collectRecords(reopened);
      expect(iterated).toHaveLength(2);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1]);
      expect((await reopened.head())?.seq).toBe(1);
      expect((await reopened.get(genesisCid)).type).toBe("genesis");
    } finally {
      await reopened.close();
    }
  });

  it("open rejects HEAD/seq-index mismatch", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);
    } finally {
      await store.close();
    }

    const indexPath = path.join(dir, SEQ_INDEX_FILE);
    const indexBytes = await readFile(indexPath, "utf8");
    await writeFile(
      indexPath,
      `${indexBytes}${JSON.stringify({ seq: 99, cid: WRONG_PREV_CID })}\n`
    );

    await expect(IpfsSoulStore.open(dir)).rejects.toThrow(CorruptionError);
  });
});
