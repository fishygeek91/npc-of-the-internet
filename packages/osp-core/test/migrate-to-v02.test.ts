import { describe, expect, it } from "vitest";

import {
  OSP_SPEC_V01,
  OSP_SPEC_V02,
  contentAddressSideBlob,
  createRecord,
  decodeShardTextBlob,
  encodePublicKey,
  encodeShardTextBlob,
  migrateChainToV02,
  generateKeypair,
  signCore,
  verifyRecords
} from "../src/index.js";

const DOOR_ID = "discord:g";
const RESIDENCY = `door:${DOOR_ID}/epoch:1`;

describe("migrateChainToV02", () => {
  it("rewrites an osp/0.1 mini-chain to verifying osp/0.2 with side blobs", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();

    const genesis = await createRecord({
      spec: OSP_SPEC_V01,
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

    const arrivalFields = {
      spec: OSP_SPEC_V01,
      seq: 1,
      prev: genesis.cid,
      type: "attestation" as const,
      body: {
        kind: "arrival" as const,
        pop_version: "pop/0.1" as const,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: encodePublicKey(generateKeypair().publicKey),
        at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY
    };
    const arrival = await createRecord({
      ...arrivalFields,
      cosigners: [signCore(arrivalFields, door.privateKey)],
      soulPrivateKey: soul.privateKey
    });

    const shardText = "A committed shard memory.";
    const shardFields = {
      spec: OSP_SPEC_V01,
      seq: 2,
      prev: arrival.cid,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: shardText,
        distilled_at: "2026-01-02T01:00:00.000Z"
      },
      residency: RESIDENCY
    };
    const shard = await createRecord({
      ...shardFields,
      cosigners: [signCore(shardFields, door.privateKey)],
      soulPrivateKey: soul.privateKey
    });

    const drift = await createRecord({
      spec: OSP_SPEC_V01,
      seq: 3,
      prev: shard.cid,
      type: "drift",
      body: {
        summary: "patience",
        evidence: [shard.cid],
        effective_at: "2026-01-03T00:00:00.000Z"
      },
      residency: RESIDENCY,
      cosigners: [],
      soulPrivateKey: soul.privateKey
    });

    const migrated = await migrateChainToV02({
      records: [genesis.record, arrival.record, shard.record, drift.record],
      soulPrivateKey: soul.privateKey,
      doorPrivateKeys: { [DOOR_ID]: door.privateKey }
    });

    expect(migrated.records).toHaveLength(4);
    expect(migrated.records.every((record) => record.spec === OSP_SPEC_V02)).toBe(true);
    expect(migrated.blobs.size).toBe(1);

    const migratedShard = migrated.records[2];
    expect(migratedShard?.type).toBe("memory");
    if (migratedShard?.type === "memory" && migratedShard.body.kind === "shard") {
      expect("text_cid" in migratedShard.body).toBe(true);
      if ("text_cid" in migratedShard.body) {
        const bytes = migrated.blobs.get(migratedShard.body.text_cid);
        expect(bytes).toBeDefined();
        if (bytes !== undefined) {
          expect(decodeShardTextBlob(bytes)).toBe(shardText);
          const addr = await contentAddressSideBlob(encodeShardTextBlob(shardText));
          expect(migratedShard.body.text_cid).toBe(addr.cid);
        }
      }
    }

    const migratedDrift = migrated.records[3];
    expect(migratedDrift?.type).toBe("drift");
    if (migratedDrift?.type === "drift") {
      const newShardCid = migrated.cidMap.get(shard.cid);
      expect(newShardCid).toBeDefined();
      expect(migratedDrift.body.evidence).toEqual([newShardCid]);
    }

    const verified = await verifyRecords(migrated.records, {
      soulPublicKey: soul.publicKey,
      doorPublicKeys: { [DOOR_ID]: door.publicKey }
    });
    expect(verified.valid).toBe(true);
  });
});
