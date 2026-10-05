import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  OSP_SPEC_V02,
  encodeShardTextBlob,
  eraseSideBlob,
  signCore,
  type Ed25519Keypair,
  type OspRecord
} from "../src/index.js";
import { resolveBlockPath } from "../src/store/ipfs-soul-store.js";

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

  it("backfills an empty mirror from a genesis-seeded file store (LAUNCH.md seed path)", async () => {
    const fileStore = await FileSoulStore.open(fileDir);
    let genesisCid: string;
    try {
      const { record: genesisRecord } = await createGenesisRecord(soul);
      genesisCid = (await fileStore.append(genesisRecord)).cid;
      const memory = await createMemoryCandidateRecord(
        soul,
        1,
        genesisCid,
        "Seeded before mirror."
      );
      await fileStore.append(memory.record);
      await fileStore.putSideBlob(new TextEncoder().encode("side-blob payload"));
    } finally {
      await fileStore.close();
    }

    const dual = await DualSoulStore.open(fileDir, ipfsDir);
    try {
      expect((await dual.head())?.seq).toBe(1);
    } finally {
      await dual.close();
    }

    const ipfsStore = await IpfsSoulStore.open(ipfsDir);
    try {
      const ipfsHead = await ipfsStore.head();
      expect(ipfsHead?.seq).toBe(1);
      const genesisFromMirror = await ipfsStore.get(genesisCid);
      expect(genesisFromMirror.type).toBe("genesis");
    } finally {
      await ipfsStore.close();
    }
  });

  it("catches a lagging mirror up to the file head (crash between dual writes)", async () => {
    const dualSetup = await DualSoulStore.open(fileDir, ipfsDir);
    let genesisCid: string;
    try {
      const { record: genesisRecord } = await createGenesisRecord(soul);
      genesisCid = (await dualSetup.append(genesisRecord)).cid;
    } finally {
      await dualSetup.close();
    }

    // Simulate a crash after the file append but before the IPFS append.
    const fileStore = await FileSoulStore.open(fileDir);
    try {
      const memory = await createMemoryCandidateRecord(soul, 1, genesisCid, "File-only record.");
      await fileStore.append(memory.record);
    } finally {
      await fileStore.close();
    }

    const dual = await DualSoulStore.open(fileDir, ipfsDir);
    try {
      const memoryTwo = await createMemoryCandidateRecord(
        soul,
        2,
        (await dual.head())!.cid,
        "Appends work after catch-up."
      );
      await dual.append(memoryTwo.record);
      expect((await dual.head())?.seq).toBe(2);
    } finally {
      await dual.close();
    }

    const ipfsStore = await IpfsSoulStore.open(ipfsDir);
    try {
      expect((await ipfsStore.head())?.seq).toBe(2);
    } finally {
      await ipfsStore.close();
    }
  });

  it("open throws when the mirror is ahead of the authoritative file store", async () => {
    const dualSetup = await DualSoulStore.open(fileDir, ipfsDir);
    let genesisCid: string;
    try {
      const { record: genesisRecord } = await createGenesisRecord(soul);
      genesisCid = (await dualSetup.append(genesisRecord)).cid;
    } finally {
      await dualSetup.close();
    }

    const ipfsStore = await IpfsSoulStore.open(ipfsDir);
    try {
      const memory = await createMemoryCandidateRecord(soul, 1, genesisCid, "Mirror-only record.");
      await ipfsStore.append(memory.record);
    } finally {
      await ipfsStore.close();
    }

    await expect(DualSoulStore.open(fileDir, ipfsDir)).rejects.toThrow(CorruptionError);
    await expect(DualSoulStore.open(fileDir, ipfsDir)).rejects.toThrow(
      /mirror ahead of authoritative store/
    );
  });

  it("open throws when the authoritative file store is empty but the mirror is populated (review F7)", async () => {
    const dualSetup = await DualSoulStore.open(fileDir, ipfsDir);
    try {
      const { record } = await createGenesisRecord(soul);
      await dualSetup.append(record);
    } finally {
      await dualSetup.close();
    }

    // File volume lost / restored empty.
    await writeFile(path.join(fileDir, "chain.jsonl"), "");

    await expect(DualSoulStore.open(fileDir, ipfsDir)).rejects.toThrow(CorruptionError);
    await expect(DualSoulStore.open(fileDir, ipfsDir)).rejects.toThrow(
      /mirror ahead of authoritative store/
    );
    await expect(DualSoulStore.openWithRecovery(fileDir, ipfsDir)).rejects.toThrow(CorruptionError);
  });

  it("removes tombstoned blobs from the mirror at open (crash between file and IPFS delete)", async () => {
    const door = generateKeypair();
    const session = generateKeypair();
    const doorPublicKeys = { "discord:g": door.publicKey };
    const dual = await DualSoulStore.open(fileDir, ipfsDir, { doorPublicKeys });
    let blobCid = "";
    let blobBytes = new Uint8Array();
    try {
      const genesis = await createRecord({
        spec: OSP_SPEC_V02,
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
      await dual.append(genesis.record);
      const arrivalFields = {
        spec: OSP_SPEC_V02,
        seq: 1,
        prev: genesis.cid,
        type: "attestation" as const,
        body: {
          kind: "arrival" as const,
          pop_version: "pop/0.1" as const,
          door_id: "discord:g",
          epoch: 1,
          session_pubkey: encodePublicKey(session.publicKey),
          at: "2026-01-02T00:00:00.000Z"
        },
        residency: RESIDENCY
      };
      const arrival = await createRecord({
        ...arrivalFields,
        cosigners: [signCore(arrivalFields, door.privateKey)],
        soulPrivateKey: soul.privateKey
      });
      await dual.append(arrival.record);

      blobBytes = encodeShardTextBlob("private prose to erase");
      blobCid = (await dual.putSideBlob(blobBytes)).cid;
      const { contentAddressSideBlob } = await import("../src/index.js");
      const blob = await contentAddressSideBlob(blobBytes);
      const shardFields = {
        spec: OSP_SPEC_V02,
        seq: 2,
        prev: arrival.cid,
        type: "memory" as const,
        body: {
          kind: "shard" as const,
          text_cid: blob.cid,
          text_hash: blob.hash,
          distilled_at: "2026-01-02T00:30:00.000Z"
        },
        residency: RESIDENCY
      };
      const shard = await createRecord({
        ...shardFields,
        cosigners: [signCore(shardFields, door.privateKey)],
        soulPrivateKey: soul.privateKey
      });
      await dual.append(shard.record);

      await eraseSideBlob({
        store: dual,
        soulPrivateKey: soul.privateKey,
        targetCid: shard.cid,
        blobCid,
        reason: "erasure_request",
        erasedAt: "2026-01-03T00:00:00.000Z"
      });
    } finally {
      await dual.close();
    }

    // Simulate the erased prose surviving in the mirror (crash after the file delete but
    // before the IPFS delete, then a later retry appended the tombstone).
    const mirror = await IpfsSoulStore.open(ipfsDir, { doorPublicKeys });
    try {
      await mirror.putSideBlob(blobBytes);
    } finally {
      await mirror.close();
    }
    const mirrorBlockPath = resolveBlockPath(path.join(ipfsDir, "blocks"), blobCid);
    expect(existsSync(mirrorBlockPath)).toBe(true);

    const reopened = await DualSoulStore.open(fileDir, ipfsDir, { doorPublicKeys });
    try {
      expect(existsSync(mirrorBlockPath)).toBe(false);
      expect((await reopened.head())?.seq).toBe(3);
    } finally {
      await reopened.close();
    }
  });

  it("backfill skips non-CID files (e.g. orphan atomic-write temp files) in blobs/", async () => {
    const fileStore = await FileSoulStore.open(fileDir);
    try {
      const { record } = await createGenesisRecord(soul);
      await fileStore.append(record);
    } finally {
      await fileStore.close();
    }
    await writeFile(path.join(fileDir, "blobs", ".tmp-orphan-123-abc"), "torn");

    const dual = await DualSoulStore.open(fileDir, ipfsDir);
    try {
      expect((await dual.head())?.seq).toBe(0);
    } finally {
      await dual.close();
    }
    const mirror = await IpfsSoulStore.open(ipfsDir);
    try {
      const { computeCidFromCanonicalBytes } = await import("../src/crypto/cid.js");
      const tornCid = await computeCidFromCanonicalBytes(new TextEncoder().encode("torn"));
      await expect(mirror.getSideBlob(tornCid)).rejects.toThrow(/not found/);
    } finally {
      await mirror.close();
    }
  });
});
