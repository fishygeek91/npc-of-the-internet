/**
 * Same-Door re-arrival + residency-scoped commit (the daemon's commit sweep contract):
 * the Door forgets an epoch's review once the Wanderer re-arrives, so candidates of an
 * earlier residency are stranded; a scoped sweep must ignore them instead of failing.
 */
import { verifyChain, type SoulStore } from "@npc/osp-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { MemoryTranscriptSource } from "../src/distill/memory-transcript-source.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { commitQuarantinedShards } from "../src/quarantine/commit.js";
import { QuarantineError } from "../src/quarantine/errors.js";
import { Session } from "../src/session/session.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { createGenesisRecord, DOOR_ID, doorPublicKeyFor } from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const DOOR_KEYS = doorPublicKeyFor(DOOR_ID, DOOR.publicKey);

function shardsJson(epoch: number): string {
  return JSON.stringify({
    shards: Array.from({ length: 5 }, (_, i) => ({
      text: `Residency ${String(epoch)} taught me thing ${String(i + 1)}.`
    }))
  });
}

const transcript = (): MemoryTranscriptSource =>
  new MemoryTranscriptSource([
    { role: "user", text: "tell me about the river" },
    { role: "assistant", text: "It keeps leaving, like me." }
  ]);

async function kinds(store: SoulStore): Promise<string[]> {
  const out: string[] = [];
  for await (const record of store.iterate()) {
    out.push("kind" in record.body ? String(record.body.kind) : record.type);
  }
  return out;
}

describe("same-door re-arrival + residency-scoped commit", () => {
  it("re-arrives at epoch+1; a scoped sweep commits only the departed epoch", async () => {
    const store = new MemorySoulStore();
    await store.append((await createGenesisRecord(SOUL)).record);
    const clock = new FakeClock("2026-10-05T00:00:00.000Z");
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const journalDir = await mkdtemp(join(tmpdir(), "scope-journal-"));
    dirs.push(journalDir);
    const start = (): Promise<Session> =>
      Session.start({
        store,
        brain: new FakeBrain([]),
        door,
        keyring,
        doorId: DOOR_ID,
        timer: new FakeTimer(),
        clock,
        doorPublicKeys: DOOR_KEYS
      });

    // Residency 1 departs; its candidates are never committed (e.g. sweep disabled).
    const first = await start();
    expect(first.epoch).toBe(1);
    await first.depart({
      transcript: transcript(),
      journalDir,
      toDoorId: DOOR_ID,
      brain: new FakeBrain([shardsJson(1), "# one"])
    });

    // Same Door, next epoch: the Door accepted epoch 2 > lastKnownEpoch 1.
    const second = await start();
    expect(second.epoch).toBe(2);
    const depart2 = await second.depart({
      transcript: transcript(),
      journalDir,
      toDoorId: DOOR_ID,
      brain: new FakeBrain([shardsJson(2), "# two"])
    });

    clock.set("2026-10-05T01:00:00.000Z");
    const common = {
      store,
      keyring,
      door,
      doorId: DOOR_ID,
      epoch: 2,
      clock,
      quarantineWindowMs: 1_000
    };

    // Unscoped, the stranded epoch-1 candidates (first in chain order) fail the sweep.
    await expect(commitQuarantinedShards(common)).rejects.toBeInstanceOf(QuarantineError);

    const result = await commitQuarantinedShards({
      ...common,
      residency: `door:${DOOR_ID}/epoch:2`,
      journalMarkdown: depart2.journalMarkdown
    });
    expect(result.committedCids).toHaveLength(5);
    expect(result.ripeningCids).toEqual([]);
    expect(result.skippedCids).toEqual([]);
    expect(result.journalAttached).toBe(true);

    const chainKinds = await kinds(store);
    expect(chainKinds.filter((kind) => kind === "candidate")).toHaveLength(10);
    expect(chainKinds.filter((kind) => kind === "shard")).toHaveLength(5);
    expect((await verifyChain(store, { doorPublicKeys: DOOR_KEYS })).valid).toBe(true);
  });
});
