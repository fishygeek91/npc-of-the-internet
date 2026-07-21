import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyChain, type OspRecord, type SoulStore } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { runWandererCli } from "../src/cli.js";
import { FileTranscriptSource } from "../src/distill/file-transcript-source.js";
import type { TranscriptLine } from "../src/distill/types.js";
import { move } from "../src/handover/move.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { Session } from "../src/session/session.js";
import { SessionError } from "../src/session/errors.js";
import type { InboundFrame } from "../src/session/types.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { createGenesisRecord, DOOR_ID } from "./helpers/fixtures.js";
import { DOOR, OTHER_DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const NEXT_DOOR_ID = "irc:libera-wanderer";
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
    { role: "assistant", text: "Only in shards, never whole." }
  ];
}

async function buildGenesisStore(): Promise<MemorySoulStore> {
  const store = new MemorySoulStore();
  const genesis = await createGenesisRecord(SOUL);
  await store.append(genesis.record);
  return store;
}

async function collectRecords(store: SoulStore): Promise<OspRecord[]> {
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
      author_id: "user-1"
    }
  };
}

describe("move", () => {
  it("departs at door A and arrives at door B on one verifying chain", async () => {
    const store = await buildGenesisStore();
    const transcriptDir = await makeTempDir("move-transcript-");
    const journalDir = await makeTempDir("move-journal-");
    const source = await writeTranscript(transcriptDir, sampleTranscriptLines());

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

    const shardTexts = nShards(5);
    const brain = new FakeBrain([
      shardsJson(shardTexts),
      SAMPLE_JOURNAL,
      "Hello from the new door."
    ]);

    const sessionA = await Session.start({
      store,
      brain,
      door: doorA,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
    });

    const result = await move({
      session: sessionA,
      transcript: source,
      journalDir,
      nextDoor: doorB,
      nextDoorId: NEXT_DOOR_ID,
      arrive: {
        store,
        brain,
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

    expect(result.session.epoch).toBe(sessionA.epoch + 1);
    expect(doorA.getActiveSessionPubkey()).toBeNull();
    expect(doorB.getActiveSessionPubkey()).not.toBeNull();

    await expect(
      sessionA.handleInbound(createInboundFrame(DOOR_ID, sessionA.epoch, "too late", "in-late"))
    ).rejects.toThrow(SessionError);

    const inbound = createInboundFrame(NEXT_DOOR_ID, result.session.epoch, "hello", "in-1");
    const handled = await result.session.handleInbound(inbound);
    expect(handled.ok).toBe(true);

    const records = await collectRecords(store);

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

    const travel = records[travelIndex];
    if (travel?.type === "attestation" && travel.body.kind === "travel") {
      expect(travel.body.to_door_id).toBe(NEXT_DOOR_ID);
    }

    const arrival = records[arrivalIndex];
    if (arrival?.type === "attestation" && arrival.body.kind === "arrival") {
      expect(arrival.body.epoch).toBe(result.session.epoch);
      expect(arrival.cosigners.length).toBeGreaterThan(0);
    }

    const chainResult = await verifyChain(store, {
      doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
    });
    expect(chainResult.valid).toBe(true);
  });

  it("runWandererCli move delegates to injected runMove", async () => {
    const lines: string[] = [];
    const exitCode = await runWandererCli(["node", "wanderer", "move", NEXT_DOOR_ID], {
      runMove: async (doorId) => {
        expect(doorId).toBe(NEXT_DOOR_ID);
        return {
          journalPath: "/tmp/journal.md",
          nextDoorId: doorId,
          nextEpoch: 2
        };
      },
      writeStdout: (line) => {
        lines.push(line);
      },
      writeStderr: () => {
        // no-op
      }
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["Journal: /tmp/journal.md", `Arrived at ${NEXT_DOOR_ID} (epoch 2)`]);
  });
});
