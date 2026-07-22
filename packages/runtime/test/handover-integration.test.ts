import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyChain, type OspRecord } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { FileTranscriptSource } from "../src/distill/file-transcript-source.js";
import type { TranscriptLine } from "../src/distill/types.js";
import { move } from "../src/handover/move.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { Session } from "../src/session/session.js";
import type { InboundFrame } from "../src/session/types.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { createGenesisRecord, DOOR_ID } from "./helpers/fixtures.js";
import { DOOR, OTHER_DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const NEXT_DOOR_ID = "irc:libera-wanderer";
const CLOCK_START = "2026-07-20T00:00:00.000Z";
const HEARTBEAT_INTERVAL_MS = 60_000;
const MESSAGE_COUNT = 4;
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

function residencyTranscriptLines(): TranscriptLine[] {
  return [
    { role: "user", text: "What do you think about the stars?" },
    { role: "assistant", text: "They feel distant but familiar." },
    { role: "user", text: "Do you remember the last door?" },
    { role: "assistant", text: "Only in shards, never whole." },
    { role: "user", text: "Will you leave soon?" },
    { role: "assistant", text: "Always. That is the design." },
    { role: "user", text: "What stays with you when you go?" },
    { role: "assistant", text: "Questions, mostly. And a few honest lines." },
    { role: "user", text: "Any farewell for this guild?" },
    { role: "assistant", text: "Gratitude for the noise and the patience." }
  ];
}

async function collectRecords(store: MemorySoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

function createInboundFrame(
  doorId: string,
  epoch: number,
  text: string,
  msgId: string
): InboundFrame {
  return {
    type: "inbound",
    door_id: doorId,
    epoch,
    msg_id: msgId,
    issued_at: CLOCK_START,
    body: {
      text,
      author_id: "user-handover"
    }
  };
}

describe("handover integration (reside → depart → arrive)", () => {
  it("yields one continuous verifying chain across two doors with journal and epoch increment", async () => {
    const store = new MemorySoulStore();
    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const transcriptDir = await makeTempDir("handover-transcript-");
    const journalDir = await makeTempDir("handover-journal-");
    const source = await writeTranscript(transcriptDir, residencyTranscriptLines());

    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const doorA = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const doorB = new DoorStub({
      doorId: NEXT_DOOR_ID,
      doorKeypair: OTHER_DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });

    const sessionReplies = Array.from(
      { length: MESSAGE_COUNT },
      (_, index) => `Reply ${String(index + 1)}`
    );
    const sessionBrain = new FakeBrain(sessionReplies);

    const shardTexts = nShards(5);
    const distillBrain = new FakeBrain([shardsJson(shardTexts), SAMPLE_JOURNAL]);
    const arriveBrain = new FakeBrain(["Hello from the new door."]);

    const sessionA = await Session.start({
      store,
      brain: sessionBrain,
      door: doorA,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
    });

    const epochAtDoorA = sessionA.epoch;
    expect(epochAtDoorA).toBe(1);

    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      const inbound = createInboundFrame(
        DOOR_ID,
        sessionA.epoch,
        `Message ${String(index + 1)}`,
        `in-${String(index + 1)}`
      );
      const result = await sessionA.handleInbound(inbound);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(doorA.verifyOutbound(result.outbound)).toBe(true);
        expect(result.outbound.body.text).toBe(sessionReplies[index]);
      }
    }

    timer.tick();
    await sessionA.drainAppends();

    let records = await collectRecords(store);
    const heartbeatsBeforeDepart = records.filter(
      (record) => record.type === "attestation" && record.body.kind === "heartbeat"
    );
    expect(heartbeatsBeforeDepart.length).toBeGreaterThanOrEqual(1);

    const result = await move({
      session: sessionA,
      transcript: source,
      journalDir,
      nextDoor: doorB,
      nextDoorId: NEXT_DOOR_ID,
      brain: distillBrain,
      arrive: {
        store,
        brain: arriveBrain,
        keyring,
        timer,
        clock,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
      }
    });

    expect(result.depart.journalMarkdown).toBe(SAMPLE_JOURNAL);
    expect(result.depart.approvedShardIds).toHaveLength(5);
    await expect(access(result.depart.journalPath)).resolves.toBeUndefined();
    await expect(readFile(result.depart.journalPath, "utf8")).resolves.toBe(SAMPLE_JOURNAL);

    expect(result.session.epoch).toBe(epochAtDoorA + 1);

    const inboundAtB = createInboundFrame(NEXT_DOOR_ID, result.session.epoch, "hello", "in-b-1");
    const handled = await result.session.handleInbound(inboundAtB);
    expect(handled.ok).toBe(true);
    if (handled.ok) {
      expect(doorB.verifyOutbound(handled.outbound)).toBe(true);
      expect(handled.outbound.body.text).toBe("Hello from the new door.");
    }

    records = await collectRecords(store);

    const memoryCandidates = records.filter(
      (record) => record.type === "memory" && record.body.kind === "candidate"
    );
    const memoryShards = records.filter(
      (record) => record.type === "memory" && record.body.kind === "shard"
    );
    expect(memoryCandidates).toHaveLength(5);
    expect(memoryShards).toHaveLength(0);

    const departureIndex = records.findIndex(
      (record) => record.type === "attestation" && record.body.kind === "departure"
    );
    const travelIndex = records.findIndex(
      (record) => record.type === "attestation" && record.body.kind === "travel"
    );
    const arrivalIndex = records.findIndex(
      (record) =>
        record.type === "attestation" &&
        record.body.kind === "arrival" &&
        record.body.door_id === NEXT_DOOR_ID
    );

    expect(departureIndex).toBeGreaterThan(-1);
    expect(travelIndex).toBeGreaterThan(departureIndex);
    expect(arrivalIndex).toBeGreaterThan(travelIndex);

    for (let index = 0; index < memoryCandidates.length; index += 1) {
      const candidateRecord = memoryCandidates[index];
      const memoryIndex = records.indexOf(candidateRecord);
      expect(memoryIndex).toBeLessThan(departureIndex);
      if (candidateRecord.type === "memory" && candidateRecord.body.kind === "candidate") {
        expect(candidateRecord.body.text).toBe(shardTexts[index]);
        expect(candidateRecord.cosigners).toEqual([]);
        expect("journal" in candidateRecord.body).toBe(false);
      }
    }

    const departure = records[departureIndex];
    if (departure?.type === "attestation" && departure.body.kind === "departure") {
      expect(departure.body.epoch).toBe(epochAtDoorA);
      expect(departure.cosigners.length).toBeGreaterThan(0);
    }

    const travel = records[travelIndex];
    if (travel?.type === "attestation" && travel.body.kind === "travel") {
      expect(travel.body.from_door_id).toBe(DOOR_ID);
      expect(travel.body.from_epoch).toBe(epochAtDoorA);
      expect(travel.body.to_door_id).toBe(NEXT_DOOR_ID);
      expect(travel.cosigners).toEqual([]);
    }

    const arrival = records[arrivalIndex];
    if (arrival?.type === "attestation" && arrival.body.kind === "arrival") {
      expect(arrival.body.epoch).toBe(epochAtDoorA + 1);
      expect(arrival.body.door_id).toBe(NEXT_DOOR_ID);
      expect(arrival.cosigners.length).toBeGreaterThan(0);
    }

    const chainResult = await verifyChain(store, {
      doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
    });
    expect(chainResult.valid).toBe(true);

    result.session.stop();
  });
});
