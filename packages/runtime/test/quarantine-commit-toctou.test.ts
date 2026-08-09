import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyChain,
  type AppendResult,
  type HeadInfo,
  type OspRecord,
  type PutSideBlobResult,
  type SoulStore
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { FileTranscriptSource } from "../src/distill/file-transcript-source.js";
import type { TranscriptLine } from "../src/distill/types.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { commitQuarantinedShards } from "../src/quarantine/commit.js";
import { QuarantineError } from "../src/quarantine/errors.js";
import { flagCandidate } from "../src/quarantine/flag.js";
import { Session } from "../src/session/session.js";
import type { CosignRequest, CosignResponse, DoorConnection } from "../src/session/types.js";
import { DoorStub } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import { createGenesisRecord, DOOR_ID, doorPublicKeyFor } from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const CLOCK_START = "2026-07-20T00:00:00.000Z";
const QUARANTINE_WINDOW_MS = 60_000;
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

/**
 * Create a unique temp directory tracked for cleanup.
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Build N distinct first-person shard texts for FakeBrain distill output.
 */
function nShards(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `I remember feeling curious about topic ${String(index + 1)}.`
  );
}

/**
 * Serialize shard texts as distiller JSON.
 */
function shardsJson(texts: readonly string[]): string {
  return JSON.stringify({ shards: texts.map((text) => ({ text })) });
}

/**
 * Write NDJSON transcript lines and return a FileTranscriptSource.
 */
async function writeTranscript(
  dir: string,
  lines: readonly TranscriptLine[]
): Promise<FileTranscriptSource> {
  const filePath = join(dir, "transcript.jsonl");
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, content, "utf8");
  return new FileTranscriptSource(filePath);
}

/**
 * Minimal residency transcript for distill.
 */
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

/**
 * Genesis-only MemorySoulStore for quarantine tests.
 */
async function buildGenesisStore(): Promise<MemorySoulStore> {
  const store = new MemorySoulStore();
  const genesis = await createGenesisRecord(SOUL);
  await store.append(genesis.record);
  return store;
}

/**
 * Advance a FakeClock by deltaMs.
 */
function advanceClock(clock: FakeClock, deltaMs: number): void {
  const nextMs = Date.parse(clock.now()) + deltaMs;
  clock.set(new Date(nextMs).toISOString());
}

/**
 * Collect all records from a SoulStore into an array.
 */
async function collectRecords(store: SoulStore): Promise<OspRecord[]> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

/**
 * SoulStore wrapper that runs a hook once after the first {@link iterate} completes.
 * Used to append a rejection in the window between the pre-scan head capture and
 * the end of {@link scanQuarantineState} (or immediately after that scan).
 */
class AfterFirstIterateStore implements SoulStore {
  private firstIterateDone = false;

  constructor(
    private readonly inner: SoulStore,
    private readonly afterFirstIterate: () => Promise<void>
  ) {}

  async append(record: OspRecord): Promise<AppendResult> {
    return this.inner.append(record);
  }

  async head(): Promise<HeadInfo | null> {
    return this.inner.head();
  }

  async get(cid: string): Promise<OspRecord> {
    return this.inner.get(cid);
  }

  async *iterate(): AsyncIterable<OspRecord> {
    for await (const record of this.inner.iterate()) {
      yield record;
    }
    if (!this.firstIterateDone) {
      this.firstIterateDone = true;
      await this.afterFirstIterate();
    }
  }

  async putSideBlob(bytes: Uint8Array): Promise<PutSideBlobResult> {
    return this.inner.putSideBlob(bytes);
  }

  async getSideBlob(cid: string): Promise<Uint8Array> {
    return this.inner.getSideBlob(cid);
  }

  async deleteSideBlob(cid: string): Promise<void> {
    return this.inner.deleteSideBlob(cid);
  }
}

describe("quarantine commit TOCTOU + flag idempotency", () => {
  it("skips a candidate flagged mid-commit after the pre-loop scan", async () => {
    const store = await buildGenesisStore();
    const transcriptDir = await makeTempDir("toctou-transcript-");
    const journalDir = await makeTempDir("toctou-journal-");
    const source = await writeTranscript(transcriptDir, sampleTranscriptLines());

    const shardTexts = nShards(5);
    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const innerDoor = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const brain = new FakeBrain([shardsJson(shardTexts), SAMPLE_JOURNAL]);

    const session = await Session.start({
      store,
      brain,
      door: innerDoor,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });

    const departResult = await session.depart({
      transcript: source,
      journalDir
    });

    expect(departResult.candidateCids).toHaveLength(5);
    const flagDuringCommitCid = departResult.candidateCids[1];
    if (flagDuringCommitCid === undefined) {
      throw new Error("expected second candidate cid");
    }

    advanceClock(clock, QUARANTINE_WINDOW_MS + 1);

    let commitCosignCount = 0;
    const door: DoorConnection = {
      attest: (request) => innerDoor.attest(request),
      heartbeat: (request) => innerDoor.heartbeat(request),
      cosign: async (request: CosignRequest): Promise<CosignResponse> => {
        if (request.phase === "commit") {
          commitCosignCount += 1;
          if (commitCosignCount === 1) {
            await flagCandidate({
              store,
              keyring,
              candidateCid: flagDuringCommitCid,
              clock
            });
          }
        }
        return innerDoor.cosign(request);
      }
    };

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

    expect(commitResult.skippedCids).toContain(flagDuringCommitCid);
    expect(commitResult.committedCids).toHaveLength(4);

    const records = await collectRecords(store);
    const flaggedCommitted = records.some(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "shard" &&
        record.body.candidate_cid === flagDuringCommitCid
    );
    expect(flaggedCommitted).toBe(false);

    const chainResult = await verifyChain(store, {
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });
    expect(chainResult.valid).toBe(true);
  });

  it("rejects a second flagCandidate on an already-rejected CID", async () => {
    const store = await buildGenesisStore();
    const transcriptDir = await makeTempDir("flag-idem-transcript-");
    const journalDir = await makeTempDir("flag-idem-journal-");
    const source = await writeTranscript(transcriptDir, sampleTranscriptLines());

    const shardTexts = nShards(5);
    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const brain = new FakeBrain([shardsJson(shardTexts), SAMPLE_JOURNAL]);

    const session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });

    const departResult = await session.depart({
      transcript: source,
      journalDir
    });

    const flaggedCid = departResult.candidateCids[0];
    if (flaggedCid === undefined) {
      throw new Error("expected candidate cid");
    }

    await flagCandidate({
      store,
      keyring,
      candidateCid: flaggedCid,
      clock
    });

    let caught: unknown;
    try {
      await flagCandidate({
        store,
        keyring,
        candidateCid: flaggedCid,
        clock
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QuarantineError);
    if (!(caught instanceof QuarantineError)) {
      throw new Error("expected QuarantineError");
    }
    expect(caught.reason).toBe("already_rejected");

    const records = await collectRecords(store);
    const rejectionRecords = records.filter(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "rejected" &&
        record.body.candidate_cid === flaggedCid
    );
    expect(rejectionRecords).toHaveLength(1);
  });

  it("skips a candidate flagged during the pre-loop scan (baseline head captured before scan)", async () => {
    const inner = await buildGenesisStore();
    const transcriptDir = await makeTempDir("scan-window-transcript-");
    const journalDir = await makeTempDir("scan-window-journal-");
    const source = await writeTranscript(transcriptDir, sampleTranscriptLines());

    const shardTexts = nShards(5);
    const clock = new FakeClock(CLOCK_START);
    const timer = new FakeTimer();
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const door = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
    const brain = new FakeBrain([shardsJson(shardTexts), SAMPLE_JOURNAL]);

    const session = await Session.start({
      store: inner,
      brain,
      door,
      keyring,
      doorId: DOOR_ID,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });

    const departResult = await session.depart({
      transcript: source,
      journalDir
    });

    const flagDuringScanCid = departResult.candidateCids[0];
    if (flagDuringScanCid === undefined) {
      throw new Error("expected candidate cid");
    }

    advanceClock(clock, QUARANTINE_WINDOW_MS + 1);

    // First iterate inside commit is scanQuarantineState; flag after it finishes so
    // the rejection is absent from scan.rejectedCandidateCids but seq > scanHeadSeq
    // (head was captured before the scan).
    const store = new AfterFirstIterateStore(inner, async () => {
      await flagCandidate({
        store: inner,
        keyring,
        candidateCid: flagDuringScanCid,
        clock
      });
    });

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

    expect(commitResult.skippedCids).toContain(flagDuringScanCid);
    expect(commitResult.committedCids).toHaveLength(4);

    const records = await collectRecords(inner);
    const flaggedCommitted = records.some(
      (record) =>
        record.type === "memory" &&
        record.body.kind === "shard" &&
        record.body.candidate_cid === flagDuringScanCid
    );
    expect(flaggedCommitted).toBe(false);

    const chainResult = await verifyChain(inner, {
      doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
    });
    expect(chainResult.valid).toBe(true);
  });
});
