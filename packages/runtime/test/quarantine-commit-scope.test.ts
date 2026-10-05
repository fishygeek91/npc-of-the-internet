/**
 * Same-Door re-arrival + commit scope (the daemon's commit sweep contract): the Door
 * retains each epoch's completed review across later arrivals (`cosign.past_epochs`), so
 * an earlier residency's candidates are committed with *that* epoch's session key while a
 * later residency exists; a residency-scoped sweep commits only its residency.
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
import type { DoorConnection } from "../src/session/types.js";
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
  it("re-arrives at epoch+1; scoped sweep commits its epoch, unscoped also commits the past epoch", async () => {
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
      clock,
      quarantineWindowMs: 1_000
    };

    // Scoped to epoch 2: epoch-1 candidates (first in chain order) are neither
    // committed nor reported.
    const scoped = await commitQuarantinedShards({
      ...common,
      residency: `door:${DOOR_ID}/epoch:2`,
      journalMarkdown: depart2.journalMarkdown
    });
    expect(scoped.committedCids).toHaveLength(5);
    expect(scoped.ripeningCids).toEqual([]);
    expect(scoped.skippedCids).toEqual([]);
    expect(scoped.strandedCids).toEqual([]);
    expect(scoped.journalAttached).toBe(true);

    // Unscoped: the past epoch-1 review is still retained by the Door, so its
    // candidates commit too (signed with the epoch-1 session key), with their own journal.
    const unscoped = await commitQuarantinedShards({
      ...common,
      journalFor: async (residency) =>
        residency === `door:${DOOR_ID}/epoch:1` ? "# one" : undefined
    });
    expect(unscoped.committedCids).toHaveLength(5);
    expect(unscoped.skippedCids).toHaveLength(5);
    expect(unscoped.strandedCids).toEqual([]);
    expect(unscoped.journalAttached).toBe(true);

    const chainKinds = await kinds(store);
    expect(chainKinds.filter((kind) => kind === "candidate")).toHaveLength(10);
    expect(chainKinds.filter((kind) => kind === "shard")).toHaveLength(10);
    // Each residency's shards carry their own residency (bound by the Door per epoch).
    const shardResidencies: string[] = [];
    for await (const record of store.iterate()) {
      if (record.type === "memory" && record.body.kind === "shard") {
        shardResidencies.push(String(record.residency));
      }
    }
    expect(shardResidencies.filter((r) => r.endsWith("/epoch:1"))).toHaveLength(5);
    expect(shardResidencies.filter((r) => r.endsWith("/epoch:2"))).toHaveLength(5);
    expect((await verifyChain(store, { doorPublicKeys: DOOR_KEYS })).valid).toBe(true);
  });

  it("a past epoch the Door no longer retains is reported stranded, not a sweep failure", async () => {
    const store = new MemorySoulStore();
    await store.append((await createGenesisRecord(SOUL)).record);
    const clock = new FakeClock("2026-10-05T00:00:00.000Z");
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    // Retains only the latest reviewed epoch: epoch 1's review is evicted by epoch 2's.
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock,
      cosignRetention: { maxEpochs: 1 }
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
    for (const epoch of [1, 2]) {
      const session = await start();
      expect(session.epoch).toBe(epoch);
      await session.depart({
        transcript: transcript(),
        journalDir,
        toDoorId: DOOR_ID,
        brain: new FakeBrain([shardsJson(epoch), `# ${String(epoch)}`])
      });
    }

    clock.set("2026-10-05T01:00:00.000Z");
    const common = {
      store,
      keyring,
      door,
      doorId: DOOR_ID,
      clock,
      quarantineWindowMs: 1_000
    };
    const result = await commitQuarantinedShards(common);
    expect(result.strandedCids).toHaveLength(5);
    expect(result.committedCids).toHaveLength(5);

    // A caller that remembers stranded CIDs skips them without asking the Door again.
    const again = await commitQuarantinedShards({
      ...common,
      skipCids: new Set(result.strandedCids)
    });
    expect(again.strandedCids).toEqual([]);
    expect(again.committedCids).toEqual([]);
    expect(again.skippedCids).toHaveLength(5);

    // A transport failure is still a sweep failure (never silently stranded).
    const failing: DoorConnection = {
      attest: (request) => door.attest(request),
      heartbeat: (request) => door.heartbeat(request),
      cosign: async () => {
        throw new Error("ECONNREFUSED");
      }
    };
    await expect(commitQuarantinedShards({ ...common, door: failing })).rejects.toBeInstanceOf(
      QuarantineError
    );
    expect((await kinds(store)).filter((kind) => kind === "shard")).toHaveLength(5);
    expect((await verifyChain(store, { doorPublicKeys: DOOR_KEYS })).valid).toBe(true);
  });
});
