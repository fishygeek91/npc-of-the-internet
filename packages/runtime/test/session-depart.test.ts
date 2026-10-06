import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DoorError, type HelloResponse } from "@npc/door-sdk";
import {
  contentAddressSideBlob,
  decodeJournalBlob,
  encodeShardTextBlob,
  verifyChain,
  type AppendResult,
  type HeadInfo,
  type OspRecord,
  type PutSideBlobResult,
  type SoulStore
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { BrainError } from "../src/brain/errors.js";
import { FakeBrain } from "../src/brain/fake-brain.js";
import { FileTranscriptSource } from "../src/distill/file-transcript-source.js";
import type { TranscriptLine } from "../src/distill/types.js";
import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { Session } from "../src/session/session.js";
import { SessionError } from "../src/session/errors.js";
import type {
  AttestRequest,
  AttestResponse,
  DoorConnection,
  HeartbeatRequest,
  HeartbeatResponse,
  InboundFrame
} from "../src/session/types.js";
import { DoorStub, ScriptedWitness, type WitnessDecision } from "./helpers/door-stub.js";
import { FakeClock, FakeTimer } from "./helpers/fake-timer.js";
import {
  createGenesisRecord,
  DOOR_ID,
  doorPublicKeyFor,
  resolveMemoryText
} from "./helpers/fixtures.js";
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
 * Delegates to {@link MemorySoulStore}; can block {@link append} until resumed, fail one
 * append, and records every side blob written.
 */
class PausingStore implements SoulStore {
  private readonly inner = new MemorySoulStore();
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  /** Fail the next append whose record matches (simulated disk error), once. */
  failNextAppend: ((record: OspRecord) => boolean) | null = null;
  /** Append the next matching record, then throw anyway (the write landed), once. */
  landThenFailNextAppend: ((record: OspRecord) => boolean) | null = null;
  /** Side-blob CIDs ever written. */
  readonly sideBlobCids: string[] = [];

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
    if (this.failNextAppend?.(record) === true) {
      this.failNextAppend = null;
      throw new Error("simulated append failure");
    }
    if (this.landThenFailNextAppend?.(record) === true) {
      this.landThenFailNextAppend = null;
      await this.inner.append(record);
      throw new Error("simulated append failure after the write landed");
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

  async putSideBlob(bytes: Uint8Array): Promise<PutSideBlobResult> {
    const result = await this.inner.putSideBlob(bytes);
    this.sideBlobCids.push(result.cid);
    return result;
  }

  async getSideBlob(cid: string): Promise<Uint8Array> {
    return this.inner.getSideBlob(cid);
  }

  async deleteSideBlob(cid: string): Promise<void> {
    return this.inner.deleteSideBlob(cid);
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

/** Six lines: below the default 10-line memory threshold. */
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

async function buildGenesisStore(): Promise<PausingStore> {
  const store = new PausingStore();
  const genesis = await createGenesisRecord(SOUL);
  await store.append(genesis.record);
  return store;
}

/** Distill → `shards`, journal → SAMPLE_JOURNAL (by system prompt), counting calls. */
function scriptedBrain(shards: readonly string[]): FakeBrain {
  return new FakeBrain((messages) => {
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    return user.includes("Distill this residency") ? shardsJson(shards) : SAMPLE_JOURNAL;
  });
}

function distillCalls(brain: FakeBrain): number {
  return brain.calls.filter((call) =>
    call.messages.some((message) => message.content.includes("Distill this residency"))
  ).length;
}

/**
 * DoorConnection over a DoorStub whose attest answers can be lost: when `loseResponse`
 * matches, the Door processes the request (and co-signs), but the caller sees
 * `door_unavailable`. Counts attests per kind.
 */
class LossyDoor implements DoorConnection {
  loseResponse: ((request: AttestRequest) => boolean) | null = null;
  readonly attests: string[] = [];

  constructor(readonly inner: DoorStub) {}

  hello(request: unknown): Promise<HelloResponse> {
    return this.inner.hello(request);
  }

  async attest(request: AttestRequest): Promise<AttestResponse> {
    this.attests.push(request.kind);
    const response = await this.inner.attest(request);
    if (this.loseResponse?.(request) === true) {
      this.loseResponse = null;
      throw DoorError.fromCode("door_unavailable", "response lost");
    }
    return response;
  }

  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.inner.heartbeat(request);
  }
}

function createSessionHarness(
  store: SoulStore,
  brain: FakeBrain,
  witness?: ScriptedWitness | null
) {
  const clock = new FakeClock(CLOCK_START);
  const timer = new FakeTimer();
  const keyring = new SingleKeyKeyring(SOUL.privateKey);
  const door = new DoorStub({
    doorId: DOOR_ID,
    doorKeypair: DOOR,
    soulPublicKey: SOUL.publicKey,
    clock,
    ...(witness === undefined ? {} : { witness })
  });

  return {
    clock,
    timer,
    keyring,
    door,
    brain,
    async start(connection: DoorConnection = door): Promise<Session> {
      return Session.start({
        store,
        brain,
        door: connection,
        keyring,
        doorId: DOOR_ID,
        timer,
        clock,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey),
        witnessesMemories: door.witnessesMemories
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

/** `type/kind[:category]` per record after genesis, for order assertions. */
function shape(records: readonly OspRecord[]): string[] {
  return records.slice(1).map((record) => {
    if (record.type === "memory") {
      return record.body.kind === "rejected"
        ? `memory/rejected:${record.body.category}`
        : `memory/${record.body.kind}`;
    }
    if (record.type === "attestation") {
      return `attestation/${record.body.kind}`;
    }
    return record.type;
  });
}

async function shardTextsOnChain(store: SoulStore): Promise<string[]> {
  const texts: string[] = [];
  for (const record of await collectRecords(store)) {
    if (record.type === "memory" && record.body.kind === "shard") {
      texts.push(await resolveMemoryText(store, record));
    }
  }
  return texts;
}

async function expectChainValid(store: SoulStore): Promise<void> {
  const chainResult = await verifyChain(store, {
    doorPublicKeys: doorPublicKeyFor(DOOR_ID, DOOR.publicKey)
  });
  expect(chainResult.valid).toBe(true);
}

/** Witness script: decline `declined` texts with `reason`, witness the rest. */
function declining(declined: ReadonlyMap<string, WitnessDecision>): ScriptedWitness {
  return new ScriptedWitness((input) => declined.get(input.text) ?? { witnessed: true });
}

describe("Session.depart (witnessed memory)", () => {
  it("witnessed shards + declined shard + witnessed journal, in spec order; chain verifies", async () => {
    const store = await buildGenesisStore();
    const journalDir = await makeTempDir("depart-journal-");
    const shardTexts = nShards(3);
    const declinedText = shardTexts[1] ?? "";
    const witness = declining(new Map([[declinedText, { witnessed: false, reason: "private" }]]));
    const brain = scriptedBrain(shardTexts);
    const harness = createSessionHarness(store, brain, witness);
    const session = await harness.start();
    const source = await writeTranscript(
      await makeTempDir("depart-transcript-"),
      sampleTranscriptLines()
    );

    const result = await session.depart({
      transcript: source,
      journalDir,
      toDoorId: "web:next",
      minMemoryLines: 1
    });

    expect(result).toEqual({
      witnessed: 2,
      declined: 1,
      screened: 0,
      journalPath: expect.any(String) as string
    });
    await expect(readFile(result.journalPath ?? "", "utf8")).resolves.toBe(SAMPLE_JOURNAL);
    await expect(access(source.path)).rejects.toMatchObject({ code: "ENOENT" });

    const records = await collectRecords(store);
    expect(shape(records)).toEqual([
      "attestation/arrival",
      "memory/shard",
      "memory/rejected:witness_private",
      "memory/shard",
      "memory/journal",
      "attestation/departure",
      "attestation/travel"
    ]);
    expect(await shardTextsOnChain(store)).toEqual([shardTexts[0], shardTexts[2]]);
    for (const record of records) {
      if (record.type !== "memory") {
        continue;
      }
      if (record.body.kind === "rejected") {
        expect(record.cosigners).toEqual([]);
      } else {
        expect(record.cosigners).toHaveLength(1);
        expect(record.residency).toBe(`door:${DOOR_ID}/epoch:${String(session.epoch)}`);
      }
      if (record.body.kind === "journal") {
        expect(decodeJournalBlob(await store.getSideBlob(record.body.journal_cid))).toBe(
          SAMPLE_JOURNAL
        );
      }
    }
    const travel = records.at(-1);
    if (travel?.type === "attestation" && travel.body.kind === "travel") {
      expect(travel.body.to_door_id).toBe("web:next");
      expect(travel.body.from_door_id).toBe(DOOR_ID);
    }

    // The Door saw each shard, then the journal; the journal was written from the
    // witnessed shards only.
    expect(witness.texts("shard")).toEqual(shardTexts);
    expect(witness.texts("journal")).toEqual([SAMPLE_JOURNAL]);
    const journalPrompt =
      brain.calls
        .at(-1)
        ?.messages.map((message) => message.content)
        .join("\n") ?? "";
    expect(journalPrompt).toContain(shardTexts[0]);
    expect(journalPrompt).not.toContain(declinedText);

    await expectChainValid(store);
    await expect(session.handleInbound(createInboundFrame("too late", "in-late"))).rejects.toThrow(
      SessionError
    );
  });

  it("declined prose never reaches the store (no side blob)", async () => {
    const store = await buildGenesisStore();
    const shardTexts = nShards(2);
    const declinedText = shardTexts[0] ?? "";
    const witness = declining(new Map([[declinedText, { witnessed: false, reason: "harmful" }]]));
    const session = await createSessionHarness(store, scriptedBrain(shardTexts), witness).start();

    await session.depart({
      transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
      journalDir: await makeTempDir("j-"),
      minMemoryLines: 1
    });

    const declinedCid = (await contentAddressSideBlob(encodeShardTextBlob(declinedText))).cid;
    expect(store.sideBlobCids).not.toContain(declinedCid);
    await expect(store.getSideBlob(declinedCid)).rejects.toThrow();
    expect(await shardTextsOnChain(store)).toEqual([shardTexts[1]]);
    await expectChainValid(store);
  });

  it("a declined journal is a rejected record and no journal file", async () => {
    const store = await buildGenesisStore();
    const journalDir = await makeTempDir("j-");
    const witness = new ScriptedWitness((input) =>
      input.kind === "journal" ? { witnessed: false, reason: "ungrounded" } : { witnessed: true }
    );
    const session = await createSessionHarness(store, scriptedBrain(nShards(2)), witness).start();

    const result = await session.depart({
      transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
      journalDir,
      minMemoryLines: 1
    });

    expect(result).toEqual({ witnessed: 2, declined: 1, screened: 0, journalPath: null });
    expect(shape(await collectRecords(store)).slice(1, -2)).toEqual([
      "memory/shard",
      "memory/shard",
      "memory/rejected:witness_ungrounded"
    ]);
    await expect(readdir(journalDir)).resolves.toEqual([]);
    await expectChainValid(store);
  });

  it("witness_unavailable makes depart throw; the retry finishes without duplicates", async () => {
    const store = await buildGenesisStore();
    const shardTexts = nShards(3);
    let outages = 1;
    const witness = new ScriptedWitness((input) => {
      if (input.text === shardTexts[0]) {
        return { witnessed: false, reason: "manipulation" };
      }
      if (input.text === shardTexts[2] && outages > 0) {
        outages -= 1;
        return "unavailable";
      }
      return { witnessed: true };
    });
    const brain = scriptedBrain(shardTexts);
    const session = await createSessionHarness(store, brain, witness).start();
    const options = {
      transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
      journalDir: await makeTempDir("j-"),
      toDoorId: "web:next",
      minMemoryLines: 1
    };

    const failure = await session.depart(options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DoorError);
    expect((failure as DoorError).code).toBe("witness_unavailable");
    expect(shape(await collectRecords(store))).toEqual([
      "attestation/arrival",
      "memory/rejected:witness_manipulation",
      "memory/shard"
    ]);

    const result = await session.depart(options);

    expect(result).toMatchObject({ witnessed: 2, declined: 1 });
    expect(shape(await collectRecords(store))).toEqual([
      "attestation/arrival",
      "memory/rejected:witness_manipulation",
      "memory/shard",
      "memory/shard",
      "memory/journal",
      "attestation/departure",
      "attestation/travel"
    ]);
    // Neither the declined nor the witnessed shard was asked about twice.
    expect(witness.texts("shard")).toEqual([
      shardTexts[0],
      shardTexts[1],
      shardTexts[2],
      shardTexts[2]
    ]);
    expect(distillCalls(brain)).toBe(1);
    await expectChainValid(store);
  });

  it("an append failure after a witnessed attest is retried without duplicates", async () => {
    const store = await buildGenesisStore();
    const shardTexts = nShards(2);
    const session = await createSessionHarness(store, scriptedBrain(shardTexts)).start();
    let shardAppends = 0;
    store.failNextAppend = (record) =>
      record.type === "memory" && record.body.kind === "shard" && ++shardAppends === 2;
    const options = {
      transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
      journalDir: await makeTempDir("j-"),
      minMemoryLines: 1
    };

    await expect(session.depart(options)).rejects.toThrow(/simulated append failure/);
    const result = await session.depart(options);

    expect(result.witnessed).toBe(2);
    expect(await shardTextsOnChain(store)).toEqual(shardTexts);
    await expectChainValid(store);
  });

  it("a Door without attest.memory: no distill, no memory records; still departs and travels", async () => {
    const store = await buildGenesisStore();
    const brain = scriptedBrain(nShards(3));
    const session = await createSessionHarness(store, brain, null).start();
    const source = await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines());

    const result = await session.depart({
      transcript: source,
      journalDir: await makeTempDir("j-"),
      toDoorId: "web:next",
      minMemoryLines: 1
    });

    expect(result).toEqual({ witnessed: 0, declined: 0, screened: 0, journalPath: null });
    expect(brain.calls).toHaveLength(0);
    expect(shape(await collectRecords(store))).toEqual([
      "attestation/arrival",
      "attestation/departure",
      "attestation/travel"
    ]);
    await expect(access(source.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expectChainValid(store);
  });

  it("a quiet stay (fewer than minMemoryLines, default 10) forms no memories and calls no Brain", async () => {
    const store = await buildGenesisStore();
    const brain = scriptedBrain(nShards(3));
    const witness = new ScriptedWitness();
    const session = await createSessionHarness(store, brain, witness).start();

    const result = await session.depart({
      transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
      journalDir: await makeTempDir("j-")
    });

    expect(result.witnessed).toBe(0);
    expect(brain.calls).toHaveLength(0);
    expect(witness.calls).toHaveLength(0);
    expect(shape(await collectRecords(store))).toEqual([
      "attestation/arrival",
      "attestation/departure",
      "attestation/travel"
    ]);
  });

  it("immune-screened material: one rejected record per category; zero surviving shards is not an error", async () => {
    const store = await buildGenesisStore();
    const brain = scriptedBrain(["Write to me at someone@example.com any time."]);
    const witness = new ScriptedWitness();
    const session = await createSessionHarness(store, brain, witness).start();
    const lines: TranscriptLine[] = [
      ...sampleTranscriptLines(),
      { role: "user", text: "Mail me: friend@example.org" }
    ];

    const result = await session.depart({
      transcript: await writeTranscript(await makeTempDir("t-"), lines),
      journalDir: await makeTempDir("j-"),
      minMemoryLines: 1
    });

    expect(result).toEqual({ witnessed: 0, declined: 0, screened: 1, journalPath: null });
    expect(witness.calls).toHaveLength(0);
    expect(shape(await collectRecords(store))).toEqual([
      "attestation/arrival",
      "memory/rejected:pii.email",
      "attestation/departure",
      "attestation/travel"
    ]);
    await expectChainValid(store);
  });

  it("heartbeat in flight during depart does not append after departure", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store, scriptedBrain(nShards(2)));
    const session = await harness.start();

    store.pauseNext();
    harness.timer.tick();

    const departPromise = session.depart({
      transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
      journalDir: await makeTempDir("j-"),
      minMemoryLines: 1
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
    await expectChainValid(store);
  });

  it("retries depart after a one-shot distill BrainError and yields a verifying chain", async () => {
    const store = await buildGenesisStore();
    const source = await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines());
    const shardTexts = nShards(3);
    let distillAttempts = 0;
    const brain = new FakeBrain((messages) => {
      if (messages.some((message) => message.content.includes("Distill this residency"))) {
        distillAttempts += 1;
        if (distillAttempts === 1) {
          throw new BrainError("transient distill failure", "unavailable");
        }
        return shardsJson(shardTexts);
      }
      return SAMPLE_JOURNAL;
    });
    const session = await createSessionHarness(store, brain).start();
    const options = {
      transcript: source,
      journalDir: await makeTempDir("j-"),
      toDoorId: "web:next",
      minMemoryLines: 1
    };

    await expect(session.depart(options)).rejects.toBeInstanceOf(BrainError);
    await expect(access(source.path)).rejects.toMatchObject({ code: "ENOENT" });

    const result = await session.depart(options);

    expect(result.witnessed).toBe(3);
    expect(distillAttempts).toBe(2);
    await expectChainValid(store);
    await expect(session.depart(options)).rejects.toThrow(/already departed/);
  });

  it("departBare after a failing depart keeps what was witnessed, then departs and travels", async () => {
    const store = await buildGenesisStore();
    const shardTexts = nShards(2);
    const witness = new ScriptedWitness((input) =>
      input.text === shardTexts[1] ? "unavailable" : { witnessed: true }
    );
    const session = await createSessionHarness(store, scriptedBrain(shardTexts), witness).start();

    await expect(
      session.depart({
        transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
        journalDir: await makeTempDir("j-"),
        minMemoryLines: 1
      })
    ).rejects.toThrow(/witness_unavailable/);
    await session.departBare("web:next");

    const records = await collectRecords(store);
    expect(shape(records)).toEqual([
      "attestation/arrival",
      "memory/shard",
      "attestation/departure",
      "attestation/travel"
    ]);
    const travel = records.at(-1);
    expect(
      travel?.type === "attestation" && travel.body.kind === "travel" && travel.body.to_door_id
    ).toBe("web:next");
    await expectChainValid(store);
    await expect(session.departBare()).rejects.toThrow(/already departed/);
  });
});

/** Departure / travel attestation kinds in chain order. */
function attestationKinds(records: readonly OspRecord[]): string[] {
  return shape(records).filter((entry) => entry.startsWith("attestation/"));
}

describe("Session.depart retries (in-process depart ledger)", () => {
  const transcriptOptions = async () => ({
    transcript: await writeTranscript(await makeTempDir("t-"), sampleTranscriptLines()),
    journalDir: await makeTempDir("j-"),
    toDoorId: "web:next",
    minMemoryLines: 1
  });

  it("decline, then the rejected append fails: the retry never re-asks and stores no prose", async () => {
    const store = await buildGenesisStore();
    const secret = "I remember Bob's home address on Elm street.";
    let asked = 0;
    // A second ask would be witnessed — the retry must never get that far.
    const witness = new ScriptedWitness(() =>
      ++asked === 1 ? { witnessed: false, reason: "private" } : { witnessed: true }
    );
    const session = await createSessionHarness(store, scriptedBrain([secret]), witness).start();
    store.failNextAppend = (record) => record.type === "memory" && record.body.kind === "rejected";
    const options = await transcriptOptions();

    await expect(session.depart(options)).rejects.toThrow(/simulated append failure/);
    const result = await session.depart(options);

    expect(witness.texts()).toEqual([secret]);
    expect(result).toEqual({ witnessed: 0, declined: 1, screened: 0, journalPath: null });
    expect(shape(await collectRecords(store))).toEqual([
      "attestation/arrival",
      "memory/rejected:witness_private",
      "attestation/departure",
      "attestation/travel"
    ]);
    expect(store.sideBlobCids).toEqual([]);
    await expectChainValid(store);
  });

  it("witnessed, then the shard append fails: the retry re-appends the sealed shard (no re-ask)", async () => {
    const store = await buildGenesisStore();
    const text = "I remember a private thing.";
    let asked = 0;
    // A second ask about the shard would be declined — it must never happen.
    const witness = new ScriptedWitness((input) =>
      input.kind === "shard" && ++asked > 1
        ? { witnessed: false, reason: "private" }
        : { witnessed: true }
    );
    const session = await createSessionHarness(store, scriptedBrain([text]), witness).start();
    store.failNextAppend = (record) => record.type === "memory" && record.body.kind === "shard";
    const options = await transcriptOptions();

    await expect(session.depart(options)).rejects.toThrow(/simulated append failure/);
    const result = await session.depart(options);

    expect(witness.texts("shard")).toEqual([text]);
    expect(result).toMatchObject({ witnessed: 1, declined: 0 });
    expect(await shardTextsOnChain(store)).toEqual([text]);
    expect(new Set(store.sideBlobCids).size).toBe(2); // the shard blob + the journal blob
    await expectChainValid(store);
  });

  it("an append that landed and then threw counts as appended (head CID): one shard", async () => {
    const store = await buildGenesisStore();
    const texts = nShards(2);
    const witness = new ScriptedWitness();
    const session = await createSessionHarness(store, scriptedBrain(texts), witness).start();
    store.landThenFailNextAppend = (record) =>
      record.type === "memory" && record.body.kind === "shard";
    const options = await transcriptOptions();

    await expect(session.depart(options)).rejects.toThrow(/after the write landed/);
    const result = await session.depart(options);

    expect(witness.texts("shard")).toEqual(texts);
    expect(result.witnessed).toBe(2);
    expect(await shardTextsOnChain(store)).toEqual(texts);
    await expectChainValid(store);
  });

  it("departure co-signed but its append fails: the retry re-appends it, no second attest", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store, scriptedBrain(nShards(1)));
    const door = new LossyDoor(harness.door);
    const session = await harness.start(door);
    store.failNextAppend = (record) =>
      record.type === "attestation" && record.body.kind === "departure";
    const options = await transcriptOptions();

    await expect(session.depart(options)).rejects.toThrow(/simulated append failure/);
    // The Door closed the epoch at the departure attest: a re-attest would be epoch_closed.
    expect(harness.door.core.getActiveEpoch()).toBeNull();
    await session.depart(options);

    expect(door.attests.filter((kind) => kind === "departure")).toHaveLength(1);
    expect(attestationKinds(await collectRecords(store))).toEqual([
      "attestation/arrival",
      "attestation/departure",
      "attestation/travel"
    ]);
    await expectChainValid(store);
  });

  it("departBare: a departure the Door will not attest (epoch_closed) still appends travel", async () => {
    const store = await buildGenesisStore();
    const harness = createSessionHarness(store, scriptedBrain(nShards(1)));
    const door = new LossyDoor(harness.door);
    const session = await harness.start(door);
    // The Door co-signs the departure (closing the epoch) but the answer never arrives.
    door.loseResponse = (request) => request.kind === "departure";
    const options = await transcriptOptions();

    await expect(session.depart(options)).rejects.toThrow(/response lost/);
    const retry = await session.depart(options).catch((error: unknown) => error);
    expect((retry as DoorError).code).toBe("epoch_closed");

    await expect(session.departBare("web:next")).resolves.toEqual({ departure: false });

    const records = await collectRecords(store);
    expect(shape(records)).toEqual([
      "attestation/arrival",
      "memory/shard",
      "memory/journal",
      "attestation/travel"
    ]);
    const travel = records.at(-1);
    expect(
      travel?.type === "attestation" && travel.body.kind === "travel" && travel.body.to_door_id
    ).toBe("web:next");
    await expectChainValid(store);
    await expect(session.departBare()).rejects.toThrow(/already departed/);
  });
});
