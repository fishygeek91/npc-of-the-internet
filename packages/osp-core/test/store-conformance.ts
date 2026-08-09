import { mkdtemp, rm, readFile, writeFile, open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  createRecord,
  generateKeypair,
  encodePublicKey,
  canonicalize,
  computeCidFromCanonicalBytes,
  CorruptionError,
  ChainMismatchError,
  ConcurrentAppendError,
  type OspRecord,
  type Ed25519Keypair,
  type SoulStore
} from "../src/index.js";

const RESIDENCY = "door:discord:g/epoch:1";
const WRONG_PREV_CID = "bagu" + "a".repeat(57);

/** On-disk JSONL layout paths (FileSoulStore only). */
const JSONL_CHAIN_FILE = "chain.jsonl";
const JSONL_BLOBS_DIR = "blobs";

/** SoulStore plus explicit close for test lifecycle (not on the SoulStore interface). */
export type ClosableSoulStore = SoulStore & {
  close(): Promise<void>;
};

/**
 * Factory for parameterized store-conformance tests.
 * Phase A registers FileSoulStore; Phase B adds IpfsSoulStore and DualSoulStore.
 */
export type SoulStoreFactory = {
  name: string;
  open: (dir: string) => Promise<ClosableSoulStore>;
  /** When true, run JSONL/blobs on-disk canonical + non-canonical tests. FileSoulStore only. */
  supportsJsonlLayout?: boolean;
  /** Lock filename relative to store dir (default ".append.lock"). Ipfs uses "LOCK". */
  lockFile?: string;
  /** When false, skip the concurrent-append lock test (e.g. DualSoulStore). Default true. */
  supportsLockTest?: boolean;
};

/** Create a unique temporary directory for an isolated store. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "osp-store-conformance-"));
}

/** Collect all records from an async iterate() call. */
async function collectRecords(store: SoulStore): Promise<OspRecord[]> {
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
async function appendGenesis(store: SoulStore, soul: Ed25519Keypair) {
  const { record } = await createGenesisRecord(soul);
  return store.append(record);
}

/**
 * Register the shared SoulStore conformance suite for one factory implementation.
 * Call once per store backend (FileSoulStore in Phase A; Ipfs/Dual in Phase B).
 */
export function registerStoreConformance(factory: SoulStoreFactory): void {
  describe(`SoulStore conformance (${factory.name})`, () => {
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
      const store = await factory.open(dir);
      try {
        expect(await store.head()).toBeNull();

        const genesis = await appendGenesis(store, soul);
        const headAfterGenesis = await store.head();
        if (headAfterGenesis === null) {
          throw new Error("expected head after genesis");
        }
        expect(headAfterGenesis).toEqual({ cid: genesis.cid, seq: 0 });

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

    it("putSideBlob / getSideBlob / deleteSideBlob round-trip", async () => {
      const store = await factory.open(dir);
      try {
        const bytes = new TextEncoder().encode('{"side":"blob"}');
        const { cid } = await store.putSideBlob(bytes);
        const fetched = await store.getSideBlob(cid);
        expect(fetched).toEqual(bytes);

        await store.deleteSideBlob(cid);
        await expect(store.getSideBlob(cid)).rejects.toThrow(/not found/);
        // Idempotent delete.
        await store.deleteSideBlob(cid);
      } finally {
        await store.close();
      }
    });

    it("refuses append when prev does not match head", async () => {
      const store = await factory.open(dir);
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
      const store = await factory.open(dir);
      try {
        const genesis = await appendGenesis(store, soul);

        const { record } = await createMemoryCandidateRecord(soul, 2, genesis.cid, "Sequence gap.");

        await expect(store.append(record)).rejects.toThrow(ChainMismatchError);
        await expect(store.append(record)).rejects.toThrow(/append prev\/seq mismatch/);
      } finally {
        await store.close();
      }
    });

    it("refuses concurrent append when the append lock is held", async () => {
      if (factory.supportsLockTest === false) {
        return;
      }

      const store = await factory.open(dir);
      const genesis = await appendGenesis(store, soul);

      const lockPath = path.join(dir, factory.lockFile ?? ".append.lock");
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
        await store.close();
      }
    });

    if (factory.supportsJsonlLayout) {
      it("persists canonical bytes on disk and reopens cleanly", async () => {
        let genesisCid = "";
        const store = await factory.open(dir);
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
            "Canonical bytes check."
          );
          await store.append(memory.record);
        } finally {
          await store.close();
        }

        const chainPath = path.join(dir, JSONL_CHAIN_FILE);
        const chainBytes = await readFile(chainPath);
        const lineStrings = chainBytes
          .toString("utf8")
          .split("\n")
          .filter((line) => line.length > 0);

        expect(lineStrings.length).toBeGreaterThan(0);

        for (const line of lineStrings) {
          const lineBytes = new TextEncoder().encode(line);
          const parsed: unknown = JSON.parse(line);
          const expected = canonicalize(parsed);
          expect(Buffer.from(lineBytes).equals(Buffer.from(expected))).toBe(true);

          const cid = await computeCidFromCanonicalBytes(lineBytes);
          const blobBytes = await readFile(path.join(dir, JSONL_BLOBS_DIR, cid));
          expect(blobBytes.equals(Buffer.from(expected))).toBe(true);
        }

        const reopened = await factory.open(dir);
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

      it("rejects a non-canonical chain line on open", async () => {
        const store = await factory.open(dir);
        let record: OspRecord;
        try {
          const created = await createGenesisRecord(soul);
          record = created.record;
          await store.append(record);
        } finally {
          await store.close();
        }

        const compact = JSON.stringify(record);
        const nonCanonicalJson = `{ ${compact.slice(1)}`;
        const lineBytes = new TextEncoder().encode(nonCanonicalJson);
        const cid = await computeCidFromCanonicalBytes(lineBytes);
        await writeFile(
          path.join(dir, JSONL_CHAIN_FILE),
          Buffer.concat([Buffer.from(lineBytes), Buffer.from("\n")])
        );
        await writeFile(path.join(dir, JSONL_BLOBS_DIR, cid), Buffer.from(lineBytes));

        await expect(factory.open(dir)).rejects.toThrow(CorruptionError);
        await expect(factory.open(dir)).rejects.toThrow(/non-canonical chain line/);
      });
    }
  });
}
