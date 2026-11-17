import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, open as fsOpen, utimes } from "node:fs/promises";
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
  listPendingReplication,
  replicationJournalPath,
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
const TEST_REPLICATION_CID = "bagu" + "r".repeat(57);

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

  it("garbage-collects orphaned block temp files older than an hour on writable open only", async () => {
    const store = await IpfsSoulStore.open(dir);
    let genesisCid = "";
    try {
      genesisCid = (await store.append((await createGenesisRecord(soul)).record)).cid;
    } finally {
      await store.close();
    }
    const blockPath = resolveBlockPath(path.join(dir, "blocks"), genesisCid);
    const shardDir = path.dirname(blockPath);
    const blockName = path.basename(blockPath);
    // Our atomic replacement temp and blockstore-fs/steno's `.<name>.tmp` temp.
    const staleOurs = path.join(shardDir, `.tmp-${blockName}-1-aaaaaaaaaaaa`);
    const staleSteno = path.join(shardDir, `.${blockName}.tmp`);
    const freshSteno = path.join(shardDir, ".OTHER.data.tmp");
    await writeFile(staleOurs, "torn");
    await writeFile(staleSteno, "torn");
    await writeFile(freshSteno, "in flight");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await utimes(staleOurs, twoHoursAgo, twoHoursAgo);
    await utimes(staleSteno, twoHoursAgo, twoHoursAgo);

    const readOnly = await IpfsSoulStore.openReadOnly(dir);
    await readOnly.close();
    expect(existsSync(staleOurs)).toBe(true);
    expect(existsSync(staleSteno)).toBe(true);

    const reopened = await IpfsSoulStore.open(dir);
    try {
      expect((await reopened.head())?.cid).toBe(genesisCid);
    } finally {
      await reopened.close();
    }
    expect(existsSync(staleOurs)).toBe(false);
    expect(existsSync(staleSteno)).toBe(false);
    expect(existsSync(freshSteno)).toBe(true);
    expect(existsSync(blockPath)).toBe(true);
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

  it("openWithRecovery truncates a torn replication.jsonl tail", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);
    } finally {
      await store.close();
    }

    const journalPath = replicationJournalPath(dir);
    const validLine = `${JSON.stringify({
      cid: TEST_REPLICATION_CID,
      kind: "record",
      enqueued_at: "2026-08-09T12:00:00.000Z"
    })}\n`;
    const tornTail = '{"cid":"bagu';
    await writeFile(journalPath, validLine + tornTail, "utf8");

    const { store: recovered, truncatedBytes } = await IpfsSoulStore.openWithRecovery(dir);
    try {
      expect(truncatedBytes).toBe(tornTail.length);
      const pending = await listPendingReplication(dir);
      expect(pending).toEqual([
        {
          cid: TEST_REPLICATION_CID,
          kind: "record",
          enqueued_at: "2026-08-09T12:00:00.000Z"
        }
      ]);
    } finally {
      await recovered.close();
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

  it("openWithRecovery clears a LOCK left by a previous incarnation with OUR pid (container PID 1)", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);
    } finally {
      await store.close();
    }

    await writeFile(
      path.join(dir, LOCK_FILE),
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), nonce: "ab" })}\n`,
      { flag: "wx" }
    );
    const { store: recovered } = await IpfsSoulStore.openWithRecovery(dir);
    try {
      expect((await recovered.head())?.seq).toBe(0);
    } finally {
      await recovered.close();
    }
  });

  it("open rejects a HEAD whose CID disagrees with the seq-index at the same seq", async () => {
    let genesisCid = "";
    const store = await IpfsSoulStore.open(dir);
    try {
      genesisCid = (await appendGenesis(store, soul)).cid;
      const memory = await createMemoryCandidateRecord(soul, 1, genesisCid, "head check");
      await store.append(memory.record);
    } finally {
      await store.close();
    }

    // Same seq as the index tail, wrong CID (points at genesis).
    const headPath = path.join(dir, "HEAD");
    await writeFile(headPath, `${JSON.stringify({ cid: genesisCid, seq: 1 })}\n`);

    await expect(IpfsSoulStore.open(dir)).rejects.toThrow(CorruptionError);
    await expect(IpfsSoulStore.open(dir)).rejects.toThrow(/does not match seq-index/);
    await expect(IpfsSoulStore.openReadOnly(dir)).rejects.toThrow(CorruptionError);
    // Recovery never rewrites a HEAD that diverges from the index.
    await expect(IpfsSoulStore.openWithRecovery(dir)).rejects.toThrow(CorruptionError);
    expect(JSON.parse(await readFile(headPath, "utf8"))).toEqual({ cid: genesisCid, seq: 1 });
  });

  it("openWithRecovery verifies the indexed chain BEFORE advancing a stale HEAD", async () => {
    let genesisCid = "";
    const store = await IpfsSoulStore.open(dir);
    try {
      genesisCid = (await appendGenesis(store, soul)).cid;
    } finally {
      await store.close();
    }

    // Crash-window shape (block + index written, HEAD stale) but the extra record is signed by
    // a different key: it must not be promoted to HEAD.
    const intruder = generateKeypair();
    const forged = await createMemoryCandidateRecord(intruder, 1, genesisCid, "forged");
    const { FsBlockstore } = await import("blockstore-fs");
    const { CID } = await import("multiformats/cid");
    const blockstore = new FsBlockstore(path.join(dir, "blocks"));
    await blockstore.open();
    await blockstore.put(CID.parse(forged.cid), canonicalize(forged.record));
    await blockstore.close();
    await appendSeqIndex(path.join(dir, SEQ_INDEX_FILE), { seq: 1, cid: forged.cid });

    const headPath = path.join(dir, "HEAD");
    const headBefore = await readFile(headPath, "utf8");
    await expect(IpfsSoulStore.openWithRecovery(dir)).rejects.toThrow(/bad_soul_sig/);
    expect(await readFile(headPath, "utf8")).toBe(headBefore);
  });

  it("putSideBlob replaces a torn block instead of wedging retries", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);
      const bytes = new TextEncoder().encode(JSON.stringify("hello world"));
      const { computeCidFromCanonicalBytes } = await import("../src/crypto/cid.js");
      const cid = await computeCidFromCanonicalBytes(bytes);
      const blockPath = resolveBlockPath(path.join(dir, "blocks"), cid);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(blockPath), { recursive: true });
      await writeFile(blockPath, bytes.subarray(0, 3));

      await expect(store.putSideBlob(bytes)).resolves.toEqual({ cid });
      expect(await store.getSideBlob(cid)).toEqual(bytes);
      await expect(store.putSideBlob(bytes)).resolves.toEqual({ cid });
    } finally {
      await store.close();
    }
  });

  it("deleteSideBlob removes the block file and is idempotent", async () => {
    const store = await IpfsSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);
      const bytes = new TextEncoder().encode(JSON.stringify("erase me"));
      const { cid } = await store.putSideBlob(bytes);
      const blockPath = resolveBlockPath(path.join(dir, "blocks"), cid);
      expect(existsSync(blockPath)).toBe(true);
      await store.deleteSideBlob(cid);
      expect(existsSync(blockPath)).toBe(false);
      await expect(store.deleteSideBlob(cid)).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
