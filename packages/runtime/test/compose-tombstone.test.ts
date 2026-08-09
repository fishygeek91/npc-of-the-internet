import {
  OSP_SPEC_V02,
  contentAddressSideBlob,
  createRecord,
  encodePublicKey,
  encodeShardTextBlob,
  eraseSideBlob,
  signCore
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { composeSelf, erasedMemoryMarker } from "../src/compose/compose-self.js";
import { DOOR_ID, RESIDENCY, createGenesisRecord } from "./helpers/fixtures.js";
import { DOOR, SESSION, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

describe("composeSelf osp/0.2 tombstones", () => {
  it("shows a visible erased marker after shard → cosign → tombstone", async () => {
    const store = new MemorySoulStore();
    const genesis = await createGenesisRecord(SOUL);
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
        session_pubkey: encodePublicKey(SESSION.publicKey),
        at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY
    };
    const arrival = await createRecord({
      ...arrivalFields,
      cosigners: [signCore(arrivalFields, DOOR.privateKey)],
      soulPrivateKey: SOUL.privateKey
    });
    await store.append(arrival.record);

    const text = "A memory that will be erased.";
    const bytes = encodeShardTextBlob(text);
    const { cid: textCid, hash: textHash } = await contentAddressSideBlob(bytes);
    await store.putSideBlob(bytes);

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
    const shard = await createRecord({
      ...shardFields,
      cosigners: [signCore(shardFields, DOOR.privateKey)],
      soulPrivateKey: SOUL.privateKey
    });
    await store.append(shard.record);

    const before = await composeSelf(store, {
      doorPublicKeys: { [DOOR_ID]: DOOR.publicKey }
    });
    expect(before.memoryIndex.some((entry) => entry.text === text)).toBe(true);

    await eraseSideBlob({
      store,
      soulPrivateKey: SOUL.privateKey,
      targetCid: shard.cid,
      blobCid: textCid,
      reason: "erasure_request",
      erasedAt: "2026-01-03T00:00:00.000Z"
    });

    const after = await composeSelf(store, {
      doorPublicKeys: { [DOOR_ID]: DOOR.publicKey }
    });
    const marker = erasedMemoryMarker("erasure_request");
    expect(after.systemPrompt).toContain(marker);
    expect(after.memoryIndex.some((entry) => entry.text === marker)).toBe(true);
    expect(after.memoryIndex.some((entry) => entry.text === text)).toBe(false);
  });
});
