import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyChain,
  type AppendResult,
  type HeadInfo,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { FileTranscriptSource } from "../src/distill/file-transcript-source.js";
import type { TranscriptLine } from "../src/distill/types.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { Session } from "../src/session/session.js";
import { SessionError } from "../src/session/errors.js";
import type { InboundFrame } from "../src/session/types.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { createGenesisRecord, DOOR_ID } from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const CLOCK_START = "2026-07-20T00:00:00.000Z";
const HEARTBEAT_INTERVAL_MS = 60_000;
const SAMPLE_JOURNAL = `# Leaving ${DOOR_ID}

I remember the quiet hours and the questions that kept arriving like weather.`;

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Delegates to {@link MemorySoulStore} but can block {@link append} until resumed.
 */
class PausingStore implements SoulStore {
  private readonly inner = new MemorySoulStore();
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  pauseNext(): void {
    if (this.gate !== null) {
      return;
    }
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  resume(): void {
    if (this.releaseGate !== null) {
      this.releaseGate();
      this.releaseGate = null;
      this.gate = null;
    }
  }

  async append(record: OspRecord): Promise<AppendResult> {
    if (this.gate !== null) {
      await this.gate;
    }
    return this.inner.append(record);
  }

  async head(): Promise<HeadInfo | null> {
    return this.inner.head();
  }

  async get(cid: string): Promise<OspRecord> {
    return this.inner.get(cid);
  }

  async *iterate(): AsyncIterable<OspRecord> {
    yield* this.inner.iterate();
  }
}

function nShards(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `I remember feeling curious about topic ${String(index + 1)}.`
  );
}

function shardsJson(texts: readonly string[]): string {
  return JSON.stringify({ shards: texts.map((text) => ({ text })) });
}

async function writeTranscript(
  dir: string,
  lines: readonly TranscriptLine[]
): Promise<FileTranscriptSource> {
  const filePath = join(dir, "transcript.jsonl");
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, content, "utf8");
  return new FileTranscriptSource(filePath);
}

function sampleTranscriptLines(): TranscriptLine[] {
  return [
    { role: "user", text: "What do you think about the stars?" },
    { role: "assistant", text: "They feel distant but familiar." },
    { role: "user", text: "Do you remember the last door?" },
    { role: "assistant", text: "Only in shards, never whole." },
    { role: "user", text: "Will you leave soon?" },
    { role: "assistant", text: "Always. That is the design." }
  ];
}

async function buildGenesisStore(): Promise<MemorySoulStore> {
  const store = new MemorySoulStore();
  const genesis = await createGenesisRecord(SOUL);
  await store.append(genesis.record);
  return store;
}

function createSessionHarness(store: SoulStore, brain: FakeBrain) {
  const clock = new FakeClock(CLOCK_START);
  const timer = new FakeTimer();
  const keyring = new SingleKeyKeyring(SOUL.privateKey);
  const door = new DoorStub({
    doorId: DOOR_ID,
    doorKeypair: DOOR,
    soulPublicKey: SOUL.publicKey,
    clock
  });

  return {
    clock,
    timer,
    keyring,
    door,
    brain,
    async start(): Promise<Session> {
      return Session.start({
        store,
        brain,
        door,
        keyring,
        doorId: DOOR_ID,
        timer,
        clock,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        doorPublicKeys: [DOOR.publicKey]
      });
    }
  };
}

function createInboundFrame(text: string, msgId: string): InboundFrame {
  return {
    type: "inbound",
    door_id: DOOR_ID,
    epoch: 1,
    msg_id: msgId,
    issued_at: CLOCK_START,
    body: {
      text,
      author_id: "user-1"
    }
  };
}

async function collectRecords(store: SoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

describe("Session.depart", () => {
  it("happy path appends memory shards, departure, travel; journal on first shard only", async () => {
    const store = await buildGenesisStore();
    const transcriptDir = await makeTempDir("depart-transcript-");
    const journalDir = await makeTempDir("depart-journal-");
    const source = await writeTranscript(transcriptDir, sampleTranscriptLines());

    const shardTexts = nShards(5);
    const brain = new FakeBrain([shardsJson(shardTexts), SAMPLE_JOURNAL]);
    const harness = createSessionHarness(store, brain);
    const session = await harness.start();

    const result = await session.depart({
      transcript: source,
      journalDir,
      toDoorId: "discord:next"
    });

    expect(result.journalMarkdown).toBe(SAMPLE_JOURNAL);
    expect(result.approvedShardIds).toEqual([
      "shard-1",
      "shard-2",
      "shard-3",
      "shard-4",
      "shard-5"
    ]);
    expect(result.rejectedShardIds).toEqual([]);
    await expect(access(result.journalPath)).resolves.toBeUndefined();
    await expect(readFile(result.journalPath, "utf8")).resolves.toBe(SAMPLE_JOURNAL);

    const records = await collectRecords(store);

    const memoryShards = records.filter(
      (record) => record.type === "memory" && record.body.kind === "shard"
    );
    expect(memoryShards).toHaveLength(5);

    const departureIndex = records.findIndex(
      (record) => record.type === "attestation" && record.body.kind === "departure"
    );
    const travelIndex = records.findIndex(
      (record) => record.type === "attestation" && record.body.kind === "travel"
    );
    expect(departureIndex).toBeGreaterThan(-1);
    expect(travelIndex).toBeGreaterThan(departureIndex);

    for (let index = 0; index < memoryShards.length; index += 1) {
      const shardRecord = memoryShards[index];
      const memoryIndex = records.indexOf(shardRecord);
      expect(memoryIndex).toBeLessThan(departureIndex);
      if (shardRecord.type === "memory" && shardRecord.body.kind === "shard") {
        expect(shardRecord.body.text).toBe(shardTexts[index]);
        if (index === 0) {
          expect(shardRecord.body.journal).toBe(SAMPLE_JOURNAL);
        } else {
          expect(shardRecord.body.journal).toBeUndefined();
        }
        expect(shardRecord.cosigners.length).toBeGreaterThan(0);
      }
    }

    const departure = records[departureIndex];
    if (departure?.type === "attestation" && departure.body.kind === "departure") {
      expect(departure.body.epoch).toBe(session.epoch);
      expect(departure.cosigners.length).toBeGreaterThan(0);
    }

    const travel = records[travelIndex];
    if (travel?.type === "attestation" && travel.body.kind === "travel") {
      expect(travel.body.from_door_id).toBe(DOOR_ID);
      expect(travel.body.from_epoch).toBe(session.epoch);
      expect(travel.body.to_door_id).toBe("discord:next");
      expect(travel.cosigners).toEqual([]);
    }

    const chainResult = await verifyChain(store, { doorPublicKeys: [DOOR.publicKey] });
    expect(chainResult.valid).toBe(true);

    await expect(session.handleInbound(createInboundFrame("too late", "in-late"))).rejects.toThrow(
      SessionError
    );
  });

  it("heartbeat in flight during depart does not append after departure", async () => {
    const store = new PausingStore();
    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const transcriptDir = await makeTempDir("depart-race-transcript-");
    const journalDir = await makeTempDir("depart-race-journal-");
    const source = await writeTranscript(transcriptDir, sampleTranscriptLines());

    const shardTexts = nShards(5);
    const brain = new FakeBrain([shardsJson(shardTexts), SAMPLE_JOURNAL]);
    const harness = createSessionHarness(store, brain);
    const session = await harness.start();

    store.pauseNext();
    harness.timer.tick();

    const departPromise = session.depart({
      transcript: source,
      journalDir
    });
    store.resume();
    await departPromise;

    const records = await collectRecords(store);

    const departureIndex = records.findIndex(
      (record) => record.type === "attestation" && record.body.kind === "departure"
    );
    expect(departureIndex).toBeGreaterThan(-1);

    const heartbeatsAfterDeparture = records
      .slice(departureIndex + 1)
      .filter((record) => record.type === "attestation" && record.body.kind === "heartbeat");
    expect(heartbeatsAfterDeparture).toHaveLength(0);

    const chainResult = await verifyChain(store, { doorPublicKeys: [DOOR.publicKey] });
    expect(chainResult.valid).toBe(true);
  });
});
