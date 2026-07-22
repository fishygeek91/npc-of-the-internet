import { describe, expect, it } from "vitest";

import { computeCid } from "@npc/osp-core";

import { isCandidateRipe, scanQuarantineState } from "../src/quarantine/scan.js";
import {
  buildFixtureB,
  CANDIDATE_TEXT,
  createRejectedRecord,
  createShardRecord,
  RESIDENCY
} from "./helpers/fixtures.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";

describe("scanQuarantineState", () => {
  it("collects candidates and cross-reference sets from the chain", async () => {
    const { store } = await buildFixtureB();
    const scan = await scanQuarantineState(store);

    expect(scan.candidates).toHaveLength(1);
    const candidate = scan.candidates[0];
    expect(candidate?.text).toBe(CANDIDATE_TEXT);
    expect(candidate?.residency).toBe(RESIDENCY);
    expect(candidate?.proposedAt).toBe("2026-01-02T01:30:00.000Z");
    expect(scan.rejectedCandidateCids.size).toBe(0);
    expect(scan.committedCandidateCids.size).toBe(0);
    // Fixture B's second shard carries body.journal.
    expect(scan.residenciesWithJournal.has(RESIDENCY)).toBe(true);
  });

  it("indexes rejected and committed candidate_cid references", async () => {
    const { store } = await buildFixtureB();
    const before = await scanQuarantineState(store);
    const candidateCid = before.candidates[0]?.cid;
    if (candidateCid === undefined) {
      throw new Error("expected candidate cid");
    }

    const head = await store.head();
    if (head === null) {
      throw new Error("expected chain head");
    }

    const rejected = await createRejectedRecord(SOUL, head.seq + 1, head.cid, "test.category", {
      candidateCid
    });
    await store.append(rejected.record);

    const rejectedHead = await store.head();
    if (rejectedHead === null) {
      throw new Error("expected chain head after rejected");
    }

    const shard = await createShardRecord(
      SOUL,
      DOOR,
      rejectedHead.seq + 1,
      rejectedHead.cid,
      "Committed from quarantine.",
      { candidateCid }
    );
    await store.append(shard.record);

    const scan = await scanQuarantineState(store);
    expect(scan.rejectedCandidateCids.has(candidateCid)).toBe(true);
    expect(scan.committedCandidateCids.has(candidateCid)).toBe(true);
  });

  it("returns candidate cids matching computeCid", async () => {
    const { store } = await buildFixtureB();
    const scan = await scanQuarantineState(store);
    const candidate = scan.candidates[0];
    if (candidate === undefined) {
      throw new Error("expected candidate");
    }

    for await (const record of store.iterate()) {
      if (record.type === "memory" && record.body.kind === "candidate") {
        expect(candidate.cid).toBe(await computeCid(record));
      }
    }
  });
});

describe("isCandidateRipe", () => {
  const windowMs = 86_400_000;

  it("returns true when the quarantine window has elapsed", () => {
    expect(isCandidateRipe("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", windowMs)).toBe(
      true
    );
  });

  it("returns false when the quarantine window has not elapsed", () => {
    expect(isCandidateRipe("2026-01-01T12:00:00.000Z", "2026-01-02T00:00:00.000Z", windowMs)).toBe(
      false
    );
  });
});
