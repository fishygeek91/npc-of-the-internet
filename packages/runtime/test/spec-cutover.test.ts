import { OSP_SPEC_V01, createRecord, encodePublicKey } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { SpecCutoverError } from "../src/osp-spec.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { Session } from "../src/session/session.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { DOOR_ID, doorPublicKeyFor } from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

describe("osp/0.1 runtime cutover guard", () => {
  it("refuses Session.start on an osp/0.1 chain without appending", async () => {
    const store = new MemorySoulStore();
    const genesis = await createRecord({
      spec: OSP_SPEC_V01,
      seq: 0,
      prev: null,
      type: "genesis",
      body: {
        charter: "# Wanderer",
        soul_pubkey: encodePublicKey(SOUL.publicKey),
        created_at: "2026-01-01T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      soulPrivateKey: SOUL.privateKey
    });
    await store.append(genesis.record);

    const clock = new FakeClock("2026-07-20T00:00:00.000Z");
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });

    await expect(
      Session.start({
        store,
        brain: new FakeBrain(["unused"]),
        door,
        keyring: new SingleKeyKeyring(SOUL.privateKey),
        doorId: DOOR_ID,
        timer: new FakeTimer(),
        clock,
        heartbeatIntervalMs: 60_000,
        doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
      })
    ).rejects.toBeInstanceOf(SpecCutoverError);

    const head = await store.head();
    expect(head?.cid).toBe(genesis.cid);
    expect(head?.seq).toBe(0);

    const records = [];
    for await (const record of store.iterate()) {
      records.push(record);
    }
    expect(records).toHaveLength(1);
    expect(records[0]?.spec).toBe(OSP_SPEC_V01);
  });
});
