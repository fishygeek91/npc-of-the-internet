import { describe, expect, it } from "vitest";

import { extractTimestamp } from "../src/log-format.js";
import type { OspRecord } from "@npc/osp-core";

const DUMMY_SIG =
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const DUMMY_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RESIDENCY = "door:discord:g/epoch:1";
const PREV_CID = "bagu4eraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Shared envelope fields for minimal typed fixtures. */
function envelope(
  seq: number,
  residency: string | null = RESIDENCY
): Omit<OspRecord, "type" | "body"> {
  return {
    spec: "osp/0.1",
    seq,
    prev: seq === 0 ? null : PREV_CID,
    residency,
    cosigners: [],
    sig: DUMMY_SIG
  };
}

describe("extractTimestamp", () => {
  it("reads created_at from genesis", () => {
    const record: OspRecord = {
      ...envelope(0, null),
      type: "genesis",
      body: {
        charter: "# test",
        soul_pubkey: DUMMY_PUBKEY,
        created_at: "2026-01-01T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reads distilled_at from memory/shard", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "memory",
      body: {
        kind: "shard",
        text: "shard text",
        distilled_at: "2026-01-02T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-02T00:00:00.000Z");
  });

  it("reads proposed_at from memory/candidate", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "memory",
      body: {
        kind: "candidate",
        text: "candidate text",
        proposed_at: "2026-01-03T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-03T00:00:00.000Z");
  });

  it("reads rejected_at from memory/rejected", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "memory",
      body: {
        kind: "rejected",
        category: "injection",
        rejected_at: "2026-01-04T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-04T00:00:00.000Z");
  });

  it("reads effective_at from drift", () => {
    const record: OspRecord = {
      ...envelope(2),
      type: "drift",
      body: {
        summary: "drift summary",
        evidence: [PREV_CID],
        effective_at: "2026-01-05T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-05T00:00:00.000Z");
  });

  it("reads decided_at from decision", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "decision",
      body: {
        decision: "stay",
        reasoning: "because",
        decided_at: "2026-01-06T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-06T00:00:00.000Z");
  });

  it("reads executed_at from transaction", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "transaction",
      body: {
        direction: "in",
        amount: "1.00",
        currency: "USD",
        executed_at: "2026-01-07T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-07T00:00:00.000Z");
  });

  it("reads at from attestation/arrival", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "attestation",
      body: {
        kind: "arrival",
        pop_version: "pop/0.1",
        door_id: "discord:g",
        epoch: 1,
        session_pubkey: DUMMY_PUBKEY,
        at: "2026-01-08T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-08T00:00:00.000Z");
  });

  it("reads at from attestation/heartbeat", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: "pop/0.1",
        door_id: "discord:g",
        epoch: 1,
        session_pubkey: DUMMY_PUBKEY,
        at: "2026-01-08T01:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-08T01:00:00.000Z");
  });

  it("reads at from attestation/departure", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "attestation",
      body: {
        kind: "departure",
        pop_version: "pop/0.1",
        door_id: "discord:g",
        epoch: 1,
        at: "2026-01-08T02:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-08T02:00:00.000Z");
  });

  it("reads at from attestation/travel", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "attestation",
      body: {
        kind: "travel",
        pop_version: "pop/0.1",
        from_door_id: "discord:g",
        from_epoch: 1,
        at: "2026-01-08T03:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-08T03:00:00.000Z");
  });

  it("reads at from attestation/handover", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "attestation",
      body: {
        kind: "handover",
        pop_version: "pop/0.1",
        depart_door_id: "discord:g",
        arrive_door_id: "discord:h",
        depart_epoch: 1,
        arrive_epoch: 2,
        at: "2026-01-08T04:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-08T04:00:00.000Z");
  });

  it("reads as_of from sleep", () => {
    const record: OspRecord = {
      ...envelope(1),
      type: "sleep",
      body: {
        reason: "low balance",
        balance: "0.00",
        threshold: "1.00",
        as_of: "2026-01-09T00:00:00.000Z"
      }
    };
    expect(extractTimestamp(record)).toBe("2026-01-09T00:00:00.000Z");
  });
});
