import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { CorruptionError } from "../src/errors.js";
import {
  ackReplication,
  enqueueReplication,
  listPendingReplication,
  listUnackedForTarget,
  readReplicationJournal,
  recoverReplicationJournal,
  replicationJournalPath,
  type ReplicationEnqueueEntry
} from "../src/replication/index.js";

const TEST_CID = "bagu" + "a".repeat(57);
const OTHER_CID = "bagu" + "b".repeat(57);
const ENQUEUED_AT = "2026-01-01T00:00:00.000Z";
const ACKED_AT = "2026-01-02T00:00:00.000Z";
const TARGET = "storacha";

/** Create a unique temporary directory for an isolated journal. */
async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "osp-replication-queue-"));
}

/** Build a test enqueue entry. */
function makeEnqueue(
  cid: string = TEST_CID,
  kind: ReplicationEnqueueEntry["kind"] = "record"
): ReplicationEnqueueEntry {
  return { cid, kind, enqueued_at: ENQUEUED_AT };
}

describe("replication queue", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("enqueue + ack; listUnackedForTarget returns pending then empty", async () => {
    await enqueueReplication(dir, makeEnqueue(TEST_CID));
    await enqueueReplication(dir, makeEnqueue(OTHER_CID));

    const pendingBefore = await listUnackedForTarget(dir, TARGET);
    expect(pendingBefore).toEqual([makeEnqueue(TEST_CID), makeEnqueue(OTHER_CID)]);

    await ackReplication(dir, { acked: TEST_CID, target: TARGET, at: ACKED_AT });

    const pendingAfterOne = await listUnackedForTarget(dir, TARGET);
    expect(pendingAfterOne).toEqual([makeEnqueue(OTHER_CID)]);

    await ackReplication(dir, { acked: OTHER_CID, target: TARGET, at: ACKED_AT });

    expect(await listUnackedForTarget(dir, TARGET)).toEqual([]);
    expect(await listPendingReplication(dir)).toEqual([]);
  });

  it("ack twice is idempotent; list empty after ack", async () => {
    await enqueueReplication(dir, makeEnqueue());
    await ackReplication(dir, { acked: TEST_CID, target: TARGET, at: ACKED_AT });
    await ackReplication(dir, { acked: TEST_CID, target: TARGET, at: ACKED_AT });

    expect(await listUnackedForTarget(dir, TARGET)).toEqual([]);
    expect(await listPendingReplication(dir)).toEqual([]);

    const journal = await readReplicationJournal(dir);
    expect(journal.filter((line) => line.type === "ack")).toHaveLength(2);
  });

  it("acks are per target", async () => {
    await enqueueReplication(dir, makeEnqueue());
    await ackReplication(dir, { acked: TEST_CID, target: "storacha", at: ACKED_AT });

    expect(await listUnackedForTarget(dir, "storacha")).toEqual([]);
    expect(await listUnackedForTarget(dir, "pinata")).toEqual([makeEnqueue()]);
  });

  it("torn trailing line throws on read and recovers via recoverReplicationJournal", async () => {
    const journalPath = replicationJournalPath(dir);
    const validLine = `${JSON.stringify({
      cid: TEST_CID,
      kind: "record",
      enqueued_at: ENQUEUED_AT
    })}\n`;
    const tornTail = '{"cid":"bagu';
    await writeFile(journalPath, validLine + tornTail, "utf8");

    await expect(readReplicationJournal(dir)).rejects.toThrow(CorruptionError);
    await expect(readReplicationJournal(dir)).rejects.toThrow(/truncated trailing line/);

    const truncatedBytes = await recoverReplicationJournal(dir);
    expect(truncatedBytes).toBe(tornTail.length);

    const journal = await readReplicationJournal(dir);
    expect(journal).toEqual([
      {
        type: "enqueue",
        cid: TEST_CID,
        kind: "record",
        enqueued_at: ENQUEUED_AT
      }
    ]);

    const raw = await readFile(journalPath, "utf8");
    expect(raw).toBe(validLine);
  });

  it("readReplicationJournal distinguishes enqueue and ack lines", async () => {
    await enqueueReplication(dir, makeEnqueue(TEST_CID, "manifest"));
    await ackReplication(dir, { acked: TEST_CID, target: TARGET, at: ACKED_AT });

    const journal = await readReplicationJournal(dir);
    expect(journal).toEqual([
      {
        type: "enqueue",
        cid: TEST_CID,
        kind: "manifest",
        enqueued_at: ENQUEUED_AT
      },
      {
        type: "ack",
        acked: TEST_CID,
        target: TARGET,
        at: ACKED_AT
      }
    ]);
  });
});
