import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyChain, type OspRecord, type SoulStore } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { composeSelf } from "../src/compose/compose-self.js";
import { FileTranscriptSource } from "../src/distill/file-transcript-source.js";
import type { TranscriptLine } from "../src/distill/types.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { commitQuarantinedShards } from "../src/quarantine/commit.js";
import { flagCandidate } from "../src/quarantine/flag.js";
import { shardIdFromText } from "../src/quarantine/shard-id.js";
import { Session } from "../src/session/session.js";
import { createGenesisRecord, DOOR_ID } from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const CLOCK_START = "2026-07-20T00:00:00.000Z";
const QUARANTINE_WINDOW_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const PII_EMAIL = "operator@secret.example.com";
const PII_SHARD_TEXT = `Contact me at ${PII_EMAIL} before the guild sleeps.`;
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

function advanceClock(clock: FakeClock, deltaMs: number): void {
  const nextMs = Date.parse(clock.now()) + deltaMs;
  clock.set(new Date(nextMs).toISOString());
}

async function collectRecords(store: SoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

async function serializeChainBytes(store: SoulStore): Promise<string> {
  const records = await collectRecords(store);
  return JSON.stringify(records);
}

describe("quarantine integration", () => {
  it("drives candidate → flag → commit with no rejected payload on chain", async () => {
    const store = await buildGenesisStore();
    const transcriptDir = await makeTempDir("quarantine-transcript-");
    const journalDir = await makeTempDir("quarantine-journal-");
    const source = await writeTranscript(transcriptDir, sampleTranscriptLines());

    const goodShards = nShards(5);
    const hostRejectedText = goodShards[0];
    const hostRejectedShardId = shardIdFromText(hostRejectedText);
    const distillShards = [...goodShards, PII_SHARD_TEXT];

    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock,
      rejectShardIds: new Set([hostRejectedShardId])
    });
    const brain = new FakeBrain([shardsJson(distillShards), SAMPLE_JOURNAL]);

    const session = await Session.start({
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

    const departResult = await session.depart({
      transcript: source,
      journalDir
    });

    expect(departResult.candidateCids).toHaveLength(4);
    expect(departResult.rejectedShardIds).toEqual([hostRejectedShardId]);
    await expect(access(departResult.journalPath)).resolves.toBeUndefined();

    let records = await collectRecords(store);
    const memoryShardsAfterDepart = records.filter(
      (record) => record.type === "memory" && record.body.kind === "shard"
    );
    const memoryCandidates = records.filter(
      (record) => record.type === "memory" && record.body.kind === "candidate"
    );
    const hostRejected = records.filter(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "rejected" &&
        record.body.category === "host_rejected"
    );
    const screenRejected = records.filter(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "rejected" &&
        record.body.category === "pii.email"
    );

    expect(memoryShardsAfterDepart).toHaveLength(0);
    expect(memoryCandidates).toHaveLength(4);
    expect(hostRejected).toHaveLength(1);
    expect(screenRejected).toHaveLength(1);

    const earlyCommit = await commitQuarantinedShards({
      store,
      keyring,
      door,
      doorId: DOOR_ID,
      epoch: session.epoch,
      clock,
      quarantineWindowMs: QUARANTINE_WINDOW_MS
    });

    expect(earlyCommit.committedCids).toHaveLength(0);
    expect(earlyCommit.ripeningCids).toHaveLength(4);
    expect(earlyCommit.skippedCids).toHaveLength(0);
    expect(earlyCommit.journalAttached).toBe(false);

    const flaggedCid = departResult.candidateCids[0];
    if (flaggedCid === undefined) {
      throw new Error("expected candidate cid to flag");
    }

    await flagCandidate({
      store,
      keyring,
      candidateCid: flaggedCid,
      clock
    });

    records = await collectRecords(store);
    const flaggedRejected = records.find(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "rejected" &&
        record.body.category === "quarantine_flagged" &&
        record.body.candidate_cid === flaggedCid
    );
    expect(flaggedRejected).toBeDefined();
    if (flaggedRejected?.type === "memory" && flaggedRejected.body.kind === "rejected") {
      expect("text" in flaggedRejected.body).toBe(false);
    }

    advanceClock(clock, QUARANTINE_WINDOW_MS + 1);

    const commitResult = await commitQuarantinedShards({
      store,
      keyring,
      door,
      doorId: DOOR_ID,
      epoch: session.epoch,
      clock,
      quarantineWindowMs: QUARANTINE_WINDOW_MS,
      journalMarkdown: departResult.journalMarkdown
    });

    expect(commitResult.committedCids).toHaveLength(3);
    expect(commitResult.ripeningCids).toHaveLength(0);
    expect(commitResult.skippedCids).toEqual([flaggedCid]);
    expect(commitResult.journalAttached).toBe(true);

    records = await collectRecords(store);
    const committedShards = records.filter(
      (record) => record.type === "memory" && record.body.kind === "shard"
    );
    expect(committedShards).toHaveLength(3);

    const approvedCandidateTexts = goodShards.slice(1);
    for (const shard of committedShards) {
      if (shard.type === "memory" && shard.body.kind === "shard") {
        expect(shard.body.candidate_cid).toBeDefined();
        expect(shard.body.text).not.toBe(hostRejectedText);
        expect(shard.body.text).not.toBe(PII_SHARD_TEXT);
        expect(approvedCandidateTexts).toContain(shard.body.text);
      }
    }

    const flaggedStillCandidate = records.some(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "candidate" &&
        departResult.candidateCids.includes(flaggedCid)
    );
    expect(flaggedStillCandidate).toBe(true);

    const flaggedCommitted = committedShards.some((record) => {
      if (record.type !== "memory" || record.body.kind !== "shard") {
        return false;
      }
      return record.body.candidate_cid === flaggedCid;
    });
    expect(flaggedCommitted).toBe(false);

    const journalShards = committedShards.filter(
      (record) =>
        record.type === "memory" && record.body.kind === "shard" && "journal" in record.body
    );
    expect(journalShards).toHaveLength(1);
    const journalShard = journalShards[0];
    if (journalShard?.type === "memory" && journalShard.body.kind === "shard") {
      expect(journalShard.body.journal).toBe(departResult.journalMarkdown);
    }

    // Flagging a candidate that already has a committed shard is rejected.
    const committedCandidateCid = (() => {
      for (const shard of committedShards) {
        if (shard.type === "memory" && shard.body.kind === "shard") {
          const linked = shard.body.candidate_cid;
          if (linked !== undefined) {
            return linked;
          }
        }
      }
      return undefined;
    })();
    if (committedCandidateCid === undefined) {
      throw new Error("expected committed candidate_cid");
    }
    await expect(
      flagCandidate({
        store,
        keyring,
        candidateCid: committedCandidateCid,
        clock
      })
    ).rejects.toMatchObject({ reason: "already_committed" });

    const secondCommit = await commitQuarantinedShards({
      store,
      keyring,
      door,
      doorId: DOOR_ID,
      epoch: session.epoch,
      clock,
      quarantineWindowMs: QUARANTINE_WINDOW_MS,
      journalMarkdown: departResult.journalMarkdown
    });
    expect(secondCommit.committedCids).toHaveLength(0);
    expect(secondCommit.journalAttached).toBe(false);

    const journalShardsAfterSecond = (await collectRecords(store)).filter(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "shard" &&
        record.body.journal !== undefined
    );
    expect(journalShardsAfterSecond).toHaveLength(1);

    const chainBytes = await serializeChainBytes(store);
    expect(chainBytes).not.toContain(hostRejectedText);
    expect(chainBytes).not.toContain(PII_SHARD_TEXT);
    expect(chainBytes).not.toContain(PII_EMAIL);

    for (const candidate of memoryCandidates) {
      if (candidate.type === "memory" && candidate.body.kind === "candidate") {
        if (candidate.body.text === hostRejectedText || candidate.body.text === PII_SHARD_TEXT) {
          throw new Error("unexpected rejected text on candidate record");
        }
      }
    }

    const chainResult = await verifyChain(store, { doorPublicKeys: [DOOR.publicKey] });
    expect(chainResult.valid).toBe(true);

    const composed = await composeSelf(store, { doorPublicKeys: [DOOR.publicKey] });
    const committedTexts = approvedCandidateTexts.filter((text) => text !== goodShards[1]);
    for (const text of committedTexts) {
      expect(composed.systemPrompt).toContain(text);
    }
    expect(composed.systemPrompt).not.toContain(goodShards[1]);
    expect(composed.systemPrompt).not.toContain(PII_SHARD_TEXT);
    expect(composed.systemPrompt).not.toContain(PII_EMAIL);
    expect(composed.systemPrompt).not.toContain(hostRejectedText);
    expect(composed.systemPrompt).not.toContain(departResult.journalMarkdown);
  });
});
