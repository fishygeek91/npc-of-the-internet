import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WitnessInput } from "@npc/door-sdk";
import { verifyChain, type OspRecord } from "@npc/osp-core";
import {
  FakeBrain,
  FileTranscriptSource,
  Session,
  SingleKeyKeyring,
  type TranscriptLine
} from "@npc/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { ARRIVED_NOTICE, MOVED_ON_NOTICE, startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { FakeTimer } from "./helpers/fake-timer.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import {
  CHANNEL_ID,
  cleanupTempDirs,
  genesisStore,
  GUILD_ID,
  testConfig,
  USER_ID
} from "./helpers/harness.js";
import { TestClock } from "./helpers/test-clock.js";

const CLOCK_START = "2026-07-21T00:00:00.000Z";
const HEARTBEAT_INTERVAL_MS = 60_000;
const SAMPLE_JOURNAL = `# Leaving discord door

I remember the quiet hours and the questions that kept arriving like weather.`;

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

function shardsJson(texts: readonly string[]): string {
  return JSON.stringify({ shards: texts.map((text) => ({ text })) });
}

function nShards(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `I remember feeling curious about topic ${String(index + 1)}.`
  );
}

async function writeTranscript(dir: string, lines: readonly TranscriptLine[]): Promise<string> {
  const filePath = join(dir, "transcript.jsonl");
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, content, "utf8");
  return filePath;
}

async function collectRecords(store: {
  iterate: () => AsyncIterable<OspRecord>;
}): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

describe("door-discord residency integration", () => {
  it("runs a full residency; the Door's witness decides each memory; the chain verifies", async () => {
    const gateway = new FakeGateway();
    const clock = new TestClock(CLOCK_START);
    const timer = new FakeTimer();
    const config = await testConfig({ presenceNotices: true });
    const doorId = doorIdForGuild(GUILD_ID);
    const store = await genesisStore();

    const sessionBrain = new FakeBrain(["Hello from the channel."]);
    const distillBrain = new FakeBrain([shardsJson(nShards(5)), SAMPLE_JOURNAL]);

    let session: Session | null = null;

    const witnessed: WitnessInput[] = [];
    const handle = await startDiscordDoor({
      config,
      gateway,
      clock,
      // Declines one shard; witnesses everything else (shards and the journal).
      witness: async (input) => {
        witnessed.push(input);
        return input.text.includes("topic 3")
          ? { witnessed: false, reason: "ungrounded" }
          : { witnessed: true };
      },
      disableServers: true,
      sessionBridge: {
        handleInbound: async (frame) => {
          if (session === null) {
            return null;
          }
          const result = await session.handleInbound(frame);
          if (result.ok) {
            return result.outbound;
          }
          return null;
        }
      }
    });

    session = await Session.start({
      store,
      door: handle.connection,
      doorId,
      keyring: new SingleKeyKeyring(SOUL.privateKey),
      brain: sessionBrain,
      clock,
      timer,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: { [doorId]: DOOR.publicKey },
      witnessesMemories: true
    });

    expect(handle.status().present).toBe(true);
    expect(handle.status().epoch).toBe(1);

    const beforeRelay = gateway.sent.length;
    await gateway.emitMessage({
      id: "community-1",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "Traveler",
      content: "What do you remember?",
      isBot: false,
      replyToId: undefined
    });

    const wandererReplies = gateway.sent
      .slice(beforeRelay)
      .filter((msg) => msg.content === "Hello from the channel.");
    expect(wandererReplies.length).toBe(1);

    timer.tick();
    await session.drainAppends();

    const journalDir = await mkdtemp(join(tmpdir(), "door-discord-journal-"));
    tempDirs.push(journalDir);
    const transcriptDir = await mkdtemp(join(tmpdir(), "door-discord-transcript-"));
    tempDirs.push(transcriptDir);
    const transcriptPath = await writeTranscript(transcriptDir, [
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
    ]);

    const departed = await session.depart({
      brain: distillBrain,
      transcript: new FileTranscriptSource(transcriptPath),
      journalDir,
      toDoorId: "irc:elsewhere"
    });
    expect(departed).toMatchObject({ witnessed: 4, declined: 1 });
    expect(departed.journalPath).not.toBeNull();

    // The witness judged each memory against the Door's own record of the stay.
    expect(witnessed.map((input) => input.kind)).toEqual([
      "shard",
      "shard",
      "shard",
      "shard",
      "shard",
      "journal"
    ]);
    expect(witnessed[0]?.transcript.map((line) => [line.role, line.text])).toEqual([
      ["community", "What do you remember?"],
      ["wanderer", "Hello from the channel."]
    ]);

    const records = await collectRecords(store);
    const memoryKinds = records.filter((r) => r.type === "memory").map((r) => r.body.kind);
    expect(memoryKinds.filter((kind) => kind === "shard")).toHaveLength(4);
    expect(memoryKinds.filter((kind) => kind === "journal")).toHaveLength(1);
    expect(memoryKinds).not.toContain("candidate");
    const rejected = records.filter((r) => r.type === "memory" && r.body.kind === "rejected");
    expect(rejected.map((r) => (r.body as { category: string }).category)).toEqual([
      "witness_ungrounded"
    ]);

    const verified = await verifyChain(store, {
      doorPublicKeys: { [doorId]: DOOR.publicKey }
    });
    expect(verified.valid).toBe(true);

    expect(handle.status().present).toBe(false);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const notices = gateway.sent
      .map((m) => m.content)
      .filter((c) => c === ARRIVED_NOTICE || c === MOVED_ON_NOTICE);
    expect(notices).toEqual([ARRIVED_NOTICE, MOVED_ON_NOTICE]);

    await handle.stop();
  });
});
