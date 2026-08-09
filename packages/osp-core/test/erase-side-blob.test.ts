import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSoulStore,
  OSP_SPEC_V02,
  contentAddressSideBlob,
  createRecord,
  encodePublicKey,
  encodeShardTextBlob,
  eraseSideBlob,
  generateKeypair,
  signCore,
  verifyRecords
} from "../src/index.js";

const DOOR_ID = "discord:g";
const RESIDENCY = `door:${DOOR_ID}/epoch:1`;

describe("eraseSideBlob", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes the blob, appends a tombstone, and leaves verifyChain green", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "erase-side-blob-"));
    dirs.push(dir);

    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const store = await FileSoulStore.open(dir, {
      doorPublicKeys: { [DOOR_ID]: door.publicKey }
    });

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
      await store.append(genesis.record);

      const arrivalFields = {
        spec: OSP_SPEC_V02,
        seq: 1,
        prev: genesis.cid,
        type: "attestation" as const,
        body: {
          kind: "arrival" as const,
          pop_version: "pop/0.1" as const,
          door_id: DOOR_ID,
          epoch: 1,
          session_pubkey: encodePublicKey(session.publicKey),
          at: "2026-01-02T00:00:00.000Z"
        },
        residency: RESIDENCY
      };
      const arrivalCosig = signCore(arrivalFields, door.privateKey);
      const arrival = await createRecord({
        ...arrivalFields,
        cosigners: [arrivalCosig],
        soulPrivateKey: soul.privateKey
      });
      await store.append(arrival.record);

      const textBytes = encodeShardTextBlob("A memory that will be erased.");
      const { cid: textCid, hash: textHash } = await contentAddressSideBlob(textBytes);
      await store.putSideBlob(textBytes);

      const shardFields = {
        spec: OSP_SPEC_V02,
        seq: 2,
        prev: arrival.cid,
        type: "memory" as const,
        body: {
          kind: "shard" as const,
          text_cid: textCid,
          text_hash: textHash,
          distilled_at: "2026-01-02T01:00:00.000Z"
        },
        residency: RESIDENCY
      };
      const shardCosig = signCore(shardFields, door.privateKey);
      const shard = await createRecord({
        ...shardFields,
        cosigners: [shardCosig],
        soulPrivateKey: soul.privateKey
      });
      await store.append(shard.record);

      const { tombstoneCid } = await eraseSideBlob({
        store,
        soulPrivateKey: soul.privateKey,
        targetCid: shard.cid,
        blobCid: textCid,
        reason: "erasure_request",
        erasedAt: "2026-01-03T00:00:00.000Z"
      });

      await expect(store.getSideBlob(textCid)).rejects.toThrow(/not found/);
      const tombstone = await store.get(tombstoneCid);
      expect(tombstone.type).toBe("tombstone");
      if (tombstone.type === "tombstone") {
        expect(tombstone.body.reason).toBe("erasure_request");
        expect(tombstone.body.blob_cid).toBe(textCid);
      }

      const records = [];
      for await (const record of store.iterate()) {
        records.push(record);
      }
      const verified = await verifyRecords(records, {
        doorPublicKeys: { [DOOR_ID]: door.publicKey }
      });
      expect(verified.valid).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("refuses to delete a record CID disguised as blobCid (chain stays intact)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "erase-guard-record-"));
    dirs.push(dir);

    const soul = generateKeypair();
    const door = generateKeypair();
    const store = await FileSoulStore.open(dir, {
      doorPublicKeys: { [DOOR_ID]: door.publicKey }
    });

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
      await store.append(genesis.record);

      const textBytes = encodeShardTextBlob("guarded memory");
      const { cid: textCid, hash: textHash } = await contentAddressSideBlob(textBytes);
      await store.putSideBlob(textBytes);

      const shardFields = {
        spec: OSP_SPEC_V02,
        seq: 1,
        prev: genesis.cid,
        type: "memory" as const,
        body: {
          kind: "shard" as const,
          text_cid: textCid,
          text_hash: textHash,
          distilled_at: "2026-01-02T01:00:00.000Z"
        },
        residency: RESIDENCY
      };
      const shard = await createRecord({
        ...shardFields,
        cosigners: [signCore(shardFields, door.privateKey)],
        soulPrivateKey: soul.privateKey
      });
      await store.append(shard.record);

      await expect(
        eraseSideBlob({
          store,
          soulPrivateKey: soul.privateKey,
          targetCid: shard.cid,
          blobCid: shard.cid,
          reason: "operator",
          erasedAt: "2026-01-03T00:00:00.000Z"
        })
      ).rejects.toThrow(/not text_cid\/journal_cid/);

      await expect(
        eraseSideBlob({
          store,
          soulPrivateKey: soul.privateKey,
          targetCid: shard.cid,
          blobCid: genesis.cid,
          reason: "operator",
          erasedAt: "2026-01-03T00:00:00.000Z"
        })
      ).rejects.toThrow(/not text_cid\/journal_cid/);

      // Chain records and the real prose blob remain readable.
      expect(await store.get(shard.cid)).toBeDefined();
      expect(await store.getSideBlob(textCid)).toEqual(textBytes);
      const head = await store.head();
      expect(head?.cid).toBe(shard.cid);
    } finally {
      await store.close();
    }
  });
});
