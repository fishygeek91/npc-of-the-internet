import { mkdtemp, rm, readFile, writeFile, open as fsOpen, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  FileSoulStore,
  createRecord,
  signCore,
  generateKeypair,
  encodePublicKey,
  encodeSignature,
  decodeSignature,
  canonicalize,
  computeCidFromCanonicalBytes,
  CorruptionError,
  ChainMismatchError,
  ConcurrentAppendError,
  StorageError,
  type OspRecord,
  type Ed25519Keypair
} from "../src/index.js";

const RESIDENCY = "door:discord:g/epoch:1";
const WRONG_PREV_CID = "bagu" + "a".repeat(57);
const CHAIN_FILE = "chain.jsonl";
const LOCK_FILE = ".append.lock";

/** Create a unique temporary directory for an isolated store. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "osp-soulstore-"));
}

/** Collect all records from an async iterate() call. */
async function collectRecords(store: FileSoulStore): Promise<OspRecord[]> {
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

/** Build a signed memory shard record with door cosignature. */
async function createCosignedShardRecord(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string
) {
  const fields = {
    seq,
    prev,
    type: "memory" as const,
    body: {
      kind: "shard" as const,
      text,
      distilled_at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY
  };
  const cosig = signCore(fields, door.privateKey);
  return createRecord({
    ...fields,
    cosigners: [cosig],
    soulPrivateKey: soul.privateKey
  });
}

/** Append genesis to the store and return the append result. */
async function appendGenesis(store: FileSoulStore, soul: Ed25519Keypair) {
  const { record } = await createGenesisRecord(soul);
  return store.append(record);
}

describe("FileSoulStore", () => {
  let dir: string;
  let soul: Ed25519Keypair;

  beforeEach(async () => {
    dir = await makeTempDir();
    soul = generateKeypair();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("opens an empty store with null head, then genesis append sets head seq 0", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      expect(await store.head()).toBeNull();

      const genesis = await appendGenesis(store, soul);
      const head = await store.head();

      expect(head).not.toBeNull();
      expect(head?.seq).toBe(0);
      expect(head?.cid).toBe(genesis.cid);
    } finally {
      await store.close();
    }
  });

  it("round-trips genesis plus two candidate memories via head, get, and iterate", async () => {
    const store = await FileSoulStore.open(dir);
    try {
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
      expect(iterated[0]?.type).toBe("genesis");
      expect(iterated[1]?.body).toEqual(memoryOne.record.body);
      expect(iterated[2]?.body).toEqual(memoryTwo.record.body);
    } finally {
      await store.close();
    }
  });

  it("refuses append when prev does not match head", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);

      const { record } = await createMemoryCandidateRecord(
        soul,
        1,
        WRONG_PREV_CID,
        "Wrong prev link."
      );

      await expect(store.append(record)).rejects.toThrow(ChainMismatchError);
      await expect(store.append(record)).rejects.toThrow(/append prev\/seq mismatch/);
    } finally {
      await store.close();
    }
  });

  it("refuses append when seq has a gap", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      const genesis = await appendGenesis(store, soul);

      const { record } = await createMemoryCandidateRecord(soul, 2, genesis.cid, "Sequence gap.");

      await expect(store.append(record)).rejects.toThrow(ChainMismatchError);
      await expect(store.append(record)).rejects.toThrow(/append prev\/seq mismatch/);
    } finally {
      await store.close();
    }
  });

  it("detects torn chain on open and recovers to complete records only", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);
      const headAfterGenesis = await store.head();
      if (headAfterGenesis === null) {
        throw new Error("expected head after genesis");
      }

      const memoryOne = await createMemoryCandidateRecord(
        soul,
        1,
        headAfterGenesis.cid,
        "Recovery test memory."
      );
      await store.append(memoryOne.record);
    } finally {
      await store.close();
    }

    const chainPath = path.join(dir, CHAIN_FILE);
    const chainBytes = await readFile(chainPath);
    const partialSuffix = Buffer.from('{"seq":99,"partial":true');
    await writeFile(chainPath, Buffer.concat([chainBytes, partialSuffix]));

    await expect(FileSoulStore.open(dir)).rejects.toThrow(CorruptionError);
    await expect(FileSoulStore.open(dir)).rejects.toThrow("truncated trailing line");

    const { store: recovered, truncatedBytes } = await FileSoulStore.openWithRecovery(dir);
    try {
      expect(truncatedBytes).toBeGreaterThan(0);

      const iterated = await collectRecords(recovered);
      expect(iterated).toHaveLength(2);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1]);
    } finally {
      await recovered.close();
    }
  });

  it("refuses append while an external append lock is held, then succeeds after release", async () => {
    const store = await FileSoulStore.open(dir);
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
      await expect(store.append(record)).rejects.toThrow("another append is in progress");
    } finally {
      await lockFd.close();
      await rm(lockPath, { force: true });
    }

    const appendResult = await store.append(record);
    expect(appendResult.cid).toBeTruthy();

    const head = await store.head();
    expect(head?.seq).toBe(1);

    await store.close();
  });

  it("includes chain verification failures on CorruptionError from loadChain", async () => {
    const store = await FileSoulStore.open(dir);
    let genesisCid = "";
    try {
      const genesis = await appendGenesis(store, soul);
      genesisCid = genesis.cid;
    } finally {
      await store.close();
    }

    const blobPath = path.join(dir, "blobs", genesisCid);
    const blobBytes = await readFile(blobPath);
    const record = JSON.parse(new TextDecoder().decode(blobBytes)) as { sig: string };
    const sig = record.sig;
    record.sig = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    const tamperedBytes = canonicalize(record);
    const tamperedCid = await computeCidFromCanonicalBytes(tamperedBytes);
    await writeFile(path.join(dir, "blobs", tamperedCid), tamperedBytes);
    await writeFile(path.join(dir, CHAIN_FILE), Buffer.concat([tamperedBytes, Buffer.from("\n")]));

    try {
      await FileSoulStore.open(dir);
      expect.fail("expected CorruptionError");
    } catch (error) {
      expect(error).toBeInstanceOf(CorruptionError);
      if (error instanceof CorruptionError) {
        expect(error.failures).toBeDefined();
        expect(error.failures?.length).toBeGreaterThan(0);
      }
    }
  });

  it("throws CorruptionError when blob bytes no longer match CID", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);
      const headAfterGenesis = await store.head();
      if (headAfterGenesis === null) {
        throw new Error("expected head after genesis");
      }

      const { record } = await createMemoryCandidateRecord(
        soul,
        1,
        headAfterGenesis.cid,
        "Blob integrity test."
      );
      const appendResult = await store.append(record);

      const blobPath = path.join(dir, "blobs", appendResult.cid);
      const blobBytes = await readFile(blobPath);
      const corrupted = Buffer.from(blobBytes);
      corrupted[0] ^= 0xff;
      await writeFile(blobPath, corrupted);

      await expect(store.get(appendResult.cid)).rejects.toThrow(CorruptionError);
      await expect(store.get(appendResult.cid)).rejects.toThrow(/blob CID mismatch/);
    } finally {
      await store.close();
    }
  });

  it("re-opens a closed store with matching head and iterate order", async () => {
    const door = generateKeypair();
    let genesisCid = "";
    let shardCid = "";
    let shardBody: OspRecord["body"] | undefined;

    const writer = await FileSoulStore.open(dir, { doorPublicKeys: [door.publicKey] });
    try {
      const genesis = await appendGenesis(writer, soul);
      genesisCid = genesis.cid;

      const headAfterGenesis = await writer.head();
      if (headAfterGenesis === null) {
        throw new Error("expected head after genesis");
      }

      const memoryOne = await createMemoryCandidateRecord(
        soul,
        1,
        headAfterGenesis.cid,
        "Re-open candidate."
      );
      await writer.append(memoryOne.record);

      const headAfterOne = await writer.head();
      if (headAfterOne === null) {
        throw new Error("expected head after candidate");
      }

      const shard = await createCosignedShardRecord(
        soul,
        door,
        2,
        headAfterOne.cid,
        "Re-open shard."
      );
      const shardAppend = await writer.append(shard.record);
      shardCid = shardAppend.cid;
      shardBody = shard.record.body;
    } finally {
      await writer.close();
    }

    const reader = await FileSoulStore.open(dir, { doorPublicKeys: [door.publicKey] });
    try {
      const head = await reader.head();
      expect(head?.seq).toBe(2);
      expect(head?.cid).toBe(shardCid);

      const iterated = await collectRecords(reader);
      expect(iterated).toHaveLength(3);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1, 2]);

      const fetchedGenesis = await reader.get(genesisCid);
      const fetchedShard = await reader.get(shardCid);
      expect(fetchedGenesis.type).toBe("genesis");
      expect(fetchedShard.body).toEqual(shardBody);
    } finally {
      await reader.close();
    }
  });

  it("rejects stale-head append from a second store instance without forking the chain", async () => {
    const storeA = await FileSoulStore.open(dir);
    const storeB = await FileSoulStore.open(dir);
    let firstMemoryBody: OspRecord["body"] | undefined;
    try {
      const genesis = await appendGenesis(storeA, soul);

      const memoryForA = await createMemoryCandidateRecord(
        soul,
        1,
        genesis.cid,
        "Appended by store A."
      );
      firstMemoryBody = memoryForA.record.body;
      await storeA.append(memoryForA.record);

      const staleForB = await createMemoryCandidateRecord(
        soul,
        1,
        genesis.cid,
        "Stale append by store B."
      );
      await expect(storeB.append(staleForB.record)).rejects.toThrow(ChainMismatchError);

      const headA = await storeA.head();
      expect(headA?.seq).toBe(1);
      expect(headA?.cid).toBe(memoryForA.cid);

      if (headA === null) {
        throw new Error("expected head after store A append");
      }

      const followOn = await createMemoryCandidateRecord(
        soul,
        2,
        headA.cid,
        "Built on true head by store B."
      );
      const followResult = await storeB.append(followOn.record);
      expect(followResult.cid).toBe(followOn.cid);

      const headB = await storeB.head();
      expect(headB).toEqual({ cid: followOn.cid, seq: 2 });
    } finally {
      await storeA.close();
      await storeB.close();
    }

    const verified = await FileSoulStore.open(dir);
    try {
      const iterated = await collectRecords(verified);
      expect(iterated).toHaveLength(3);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1, 2]);
      expect(iterated[1]?.body).toEqual(firstMemoryBody);
    } finally {
      await verified.close();
    }
  });

  it("rejects path traversal CID in get() before filesystem access", async () => {
    const store = await FileSoulStore.open(dir);
    // blobsDir is <dir>/blobs, so "../sentinel" resolves to <dir>/sentinel
    const sentinelPath = path.join(dir, "sentinel");
    try {
      await appendGenesis(store, soul);
      await writeFile(sentinelPath, "traversal-success");

      await expect(store.get("../sentinel")).rejects.toThrow(StorageError);
      await expect(store.get("../sentinel")).rejects.toThrow(/invalid CID format/);

      // The error must not depend on the target existing — same error with it gone.
      await rm(sentinelPath, { force: true });
      await expect(store.get("../sentinel")).rejects.toThrow(/invalid CID format/);
    } finally {
      await store.close();
      await rm(sentinelPath, { force: true });
    }
  });

  it("rejects parent-directory CID in get() before filesystem access", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);

      await expect(store.get("../")).rejects.toThrow(StorageError);
      await expect(store.get("../")).rejects.toThrow(/invalid CID format/);
    } finally {
      await store.close();
    }
  });

  it("rejects absolute-path CID in get() before filesystem access", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);

      await expect(store.get("/etc/passwd")).rejects.toThrow(StorageError);
      await expect(store.get("/etc/passwd")).rejects.toThrow(/invalid CID format/);
    } finally {
      await store.close();
    }
  });

  it("rejects empty CID in get() before filesystem access", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);

      await expect(store.get("")).rejects.toThrow(StorageError);
      await expect(store.get("")).rejects.toThrow(/invalid CID format/);
    } finally {
      await store.close();
    }
  });

  it("rejects wrong-alphabet CID in get() before filesystem access", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);

      const wrongAlphabetCid = "baguZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

      await expect(store.get(wrongAlphabetCid)).rejects.toThrow(StorageError);
      await expect(store.get(wrongAlphabetCid)).rejects.toThrow(/invalid CID format/);
    } finally {
      await store.close();
    }
  });

  it("rejects wrong-length CID in get() before filesystem access", async () => {
    const store = await FileSoulStore.open(dir);
    try {
      await appendGenesis(store, soul);

      const wrongLengthCid = "baguabc";

      await expect(store.get(wrongLengthCid)).rejects.toThrow(StorageError);
      await expect(store.get(wrongLengthCid)).rejects.toThrow(/invalid CID format/);
    } finally {
      await store.close();
    }
  });

  it("retries append after orphan blob left by crash between blob and chain write", async () => {
    const store = await FileSoulStore.open(dir);
    let memoryCid = "";
    let memoryRecord: OspRecord;
    try {
      const genesis = await appendGenesis(store, soul);
      const memory = await createMemoryCandidateRecord(soul, 1, genesis.cid, "Orphan blob retry.");
      memoryRecord = memory.record;
      memoryCid = memory.cid;

      // Simulate durable blob write without the chain line (crash mid-append).
      const blobPath = path.join(dir, "blobs", memoryCid);
      await writeFile(blobPath, canonicalize(memoryRecord));
    } finally {
      await store.close();
    }

    const { store: recovered, truncatedBytes } = await FileSoulStore.openWithRecovery(dir);
    try {
      expect(truncatedBytes).toBe(0);
      expect(await recovered.head()).toEqual(expect.objectContaining({ seq: 0 }));

      const retry = await recovered.append(memoryRecord);
      expect(retry.cid).toBe(memoryCid);

      const head = await recovered.head();
      expect(head).toEqual({ cid: memoryCid, seq: 1 });
      expect(await collectRecords(recovered)).toHaveLength(2);
    } finally {
      await recovered.close();
    }

    const verified = await FileSoulStore.open(dir);
    try {
      const iterated = await collectRecords(verified);
      expect(iterated).toHaveLength(2);
      expect(iterated[1]?.seq).toBe(1);
    } finally {
      await verified.close();
    }
  });
});

describe("FileSoulStore.openReadOnly", () => {
  let dir: string;
  let soul: Ed25519Keypair;

  beforeEach(async () => {
    dir = await makeTempDir();
    soul = generateKeypair();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads an intact chain without creating layout or lock files", async () => {
    const writer = await FileSoulStore.open(dir);
    try {
      await appendGenesis(writer, soul);
      const headAfterGenesis = await writer.head();
      if (headAfterGenesis === null) {
        throw new Error("expected head after genesis");
      }

      const memory = await createMemoryCandidateRecord(
        soul,
        1,
        headAfterGenesis.cid,
        "Read-only happy path."
      );
      await writer.append(memory.record);
    } finally {
      await writer.close();
    }

    const reader = await FileSoulStore.openReadOnly(dir);
    try {
      expect(reader.verification().valid).toBe(true);

      const iterated = await collectRecords(reader);
      expect(iterated).toHaveLength(2);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1]);

      const head = await reader.head();
      expect(head?.seq).toBe(1);
    } finally {
      await reader.close();
    }

    await expect(access(path.join(dir, LOCK_FILE))).rejects.toThrow();
  });

  it("opens while a writer holds .append.lock", async () => {
    const writer = await FileSoulStore.open(dir);
    try {
      await appendGenesis(writer, soul);
    } finally {
      await writer.close();
    }

    const lockPath = path.join(dir, LOCK_FILE);
    const lockFd = await fsOpen(lockPath, "wx");

    try {
      const reader = await FileSoulStore.openReadOnly(dir);
      try {
        expect(reader.verification().valid).toBe(true);
        const iterated = await collectRecords(reader);
        expect(iterated).toHaveLength(1);
        expect(iterated[0]?.type).toBe("genesis");
      } finally {
        await reader.close();
      }
    } finally {
      await lockFd.close();
      await rm(lockPath, { force: true });
    }
  });

  it("ignores a torn trailing line in memory without mutating the chain file", async () => {
    const writer = await FileSoulStore.open(dir);
    try {
      await appendGenesis(writer, soul);
      const headAfterGenesis = await writer.head();
      if (headAfterGenesis === null) {
        throw new Error("expected head after genesis");
      }

      const memory = await createMemoryCandidateRecord(
        soul,
        1,
        headAfterGenesis.cid,
        "Torn tail test."
      );
      await writer.append(memory.record);
    } finally {
      await writer.close();
    }

    const chainPath = path.join(dir, CHAIN_FILE);
    const chainBytesBefore = await readFile(chainPath);
    const partialSuffix = Buffer.from('{"seq":99,"partial":true');
    await writeFile(chainPath, Buffer.concat([chainBytesBefore, partialSuffix]));

    const reader = await FileSoulStore.openReadOnly(dir);
    try {
      expect(reader.verification().valid).toBe(false);
      if (!reader.verification().valid) {
        expect(
          reader
            .verification()
            .failures.some((failure) => failure.message.includes("truncated trailing line"))
        ).toBe(true);
      }

      const iterated = await collectRecords(reader);
      expect(iterated).toHaveLength(2);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1]);

      const head = await reader.head();
      expect(head?.seq).toBe(1);
    } finally {
      await reader.close();
    }

    const chainBytesAfter = await readFile(chainPath);
    expect(chainBytesAfter.equals(Buffer.concat([chainBytesBefore, partialSuffix]))).toBe(true);
  });

  it("reports verification failure without throwing and still exposes records", async () => {
    const writer = await FileSoulStore.open(dir);
    let genesisCid = "";
    try {
      const genesis = await appendGenesis(writer, soul);
      genesisCid = genesis.cid;
    } finally {
      await writer.close();
    }

    const blobPath = path.join(dir, "blobs", genesisCid);
    const blobBytes = await readFile(blobPath);
    const record = JSON.parse(new TextDecoder().decode(blobBytes)) as { sig: string };
    // Flip one signature byte while keeping valid base64url encoding (schema still passes).
    const sigBytes = decodeSignature(record.sig);
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
    record.sig = encodeSignature(sigBytes);
    const tamperedBytes = canonicalize(record);
    const tamperedCid = await computeCidFromCanonicalBytes(tamperedBytes);
    await writeFile(path.join(dir, "blobs", tamperedCid), tamperedBytes);
    await writeFile(path.join(dir, CHAIN_FILE), Buffer.concat([tamperedBytes, Buffer.from("\n")]));

    const reader = await FileSoulStore.openReadOnly(dir);
    try {
      expect(reader.verification().valid).toBe(false);
      if (!reader.verification().valid) {
        expect(reader.verification().failures.length).toBeGreaterThan(0);
      }

      const iterated = await collectRecords(reader);
      expect(iterated).toHaveLength(1);
      expect(iterated[0]?.seq).toBe(0);

      const head = await reader.head();
      expect(head?.seq).toBe(0);
    } finally {
      await reader.close();
    }
  });

  it("reports verification failure for cosigned records opened without door keys", async () => {
    const door = generateKeypair();
    const writer = await FileSoulStore.open(dir, { doorPublicKeys: [door.publicKey] });
    try {
      const genesis = await appendGenesis(writer, soul);
      const shard = await createCosignedShardRecord(soul, door, 1, genesis.cid, "Cosigned shard.");
      await writer.append(shard.record);
    } finally {
      await writer.close();
    }

    const reader = await FileSoulStore.openReadOnly(dir);
    try {
      expect(reader.verification().valid).toBe(false);

      const iterated = await collectRecords(reader);
      expect(iterated).toHaveLength(2);
      expect(iterated.map((record) => record.seq)).toEqual([0, 1]);
    } finally {
      await reader.close();
    }
  });

  it("rejects append on a read-only store", async () => {
    const writer = await FileSoulStore.open(dir);
    try {
      await appendGenesis(writer, soul);
    } finally {
      await writer.close();
    }

    const reader = await FileSoulStore.openReadOnly(dir);
    try {
      const memory = await createMemoryCandidateRecord(soul, 1, "bagu" + "a".repeat(57), "Nope.");
      await expect(reader.append(memory.record)).rejects.toThrow(StorageError);
      await expect(reader.append(memory.record)).rejects.toThrow("FileSoulStore is read-only");
    } finally {
      await reader.close();
    }
  });

  it("throws StorageError when chain file is missing", async () => {
    await expect(FileSoulStore.openReadOnly(dir)).rejects.toThrow(StorageError);
    await expect(FileSoulStore.openReadOnly(dir)).rejects.toThrow(/chain file does not exist/);
  });
});
