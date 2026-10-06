import { describe, expect, it } from "vitest";

import {
  OSP_SPEC_V02,
  contentAddressSideBlob,
  createRecord,
  encodeJournalBlob,
  encodePublicKey,
  encodeShardTextBlob,
  signCore
} from "@npc/osp-core";

import {
  deriveJournals,
  deriveRecordsPage,
  deriveResidencies,
  deriveState,
  recordSummary
} from "../src/derive.js";
import {
  createArrivalRecord,
  createDepartureRecord,
  createGenesisRecord,
  createJournalRecord,
  createRejectedRecord,
  createShardRecord,
  createShardRecordV02,
  createSleepRecord,
  createTombstoneRecord,
  createTravelRecord,
  DEFAULT_DOOR,
  DEFAULT_DOOR_ID,
  DEFAULT_RESIDENCY,
  DEFAULT_SESSION,
  DEFAULT_SOUL
} from "./helpers/chain-builder.js";

describe("deriveState", () => {
  it("maps attestation kinds to presence states", async () => {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    expect(deriveState([genesis.record], true).status).toBe("sleeping");

    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    const presentChain = [genesis.record, arrival.record];
    expect(deriveState(presentChain, true)).toMatchObject({
      status: "present",
      door_id: DEFAULT_DOOR_ID,
      epoch: 1
    });

    const departure = await createDepartureRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      2,
      arrival.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T02:00:00.000Z"
    );
    const departureChain = [...presentChain, departure.record];
    expect(deriveState(departureChain, true)).toMatchObject({
      status: "traveling",
      door_id: null,
      epoch: 1
    });

    const travel = await createTravelRecord(
      DEFAULT_SOUL,
      3,
      departure.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T02:30:00.000Z"
    );
    expect(deriveState([...departureChain, travel.record], true)).toMatchObject({
      status: "traveling",
      door_id: null,
      epoch: 1
    });
  });

  it("returns sleeping when a sleep record is newer than arrival", async () => {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    const sleep = await createSleepRecord(DEFAULT_SOUL, 2, arrival.cid);
    expect(deriveState([genesis.record, arrival.record, sleep.record], true)).toMatchObject({
      status: "sleeping",
      door_id: null,
      epoch: null,
      since: "2026-01-02T03:00:00.000Z"
    });
  });

  it("derives handover as traveling with depart_epoch", async () => {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    const fields = {
      seq: 1,
      prev: genesis.cid,
      type: "attestation" as const,
      body: {
        kind: "handover" as const,
        pop_version: "pop/0.1" as const,
        depart_door_id: DEFAULT_DOOR_ID,
        arrive_door_id: "irc:libera-wanderer",
        depart_epoch: 1,
        arrive_epoch: 2,
        at: "2026-01-03T00:00:00.000Z"
      },
      residency: DEFAULT_RESIDENCY
    };
    const handover = await createRecord({
      ...fields,
      cosigners: [],
      soulPrivateKey: DEFAULT_SOUL.privateKey
    });

    expect(deriveState([genesis.record, handover.record], true)).toMatchObject({
      status: "traveling",
      door_id: null,
      epoch: 1,
      since: "2026-01-03T00:00:00.000Z"
    });

    const residencies = await deriveResidencies([genesis.record, handover.record], true);
    expect(residencies.residencies[0]).toMatchObject({
      door_id: DEFAULT_DOOR_ID,
      departed_at: "2026-01-03T00:00:00.000Z",
      traveled_to: "irc:libera-wanderer"
    });
  });
});

describe("deriveRecordsPage", () => {
  it("paginates and summarizes records without leaking shard text", async () => {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    const shardFields = {
      seq: 2,
      prev: arrival.cid,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: "SECRET_SHARD_TEXT",
        distilled_at: "2026-01-02T01:00:00.000Z"
      },
      residency: DEFAULT_RESIDENCY
    };
    const cosig = signCore(shardFields, DEFAULT_DOOR.privateKey);
    const shard = await createRecord({
      ...shardFields,
      cosigners: [cosig],
      soulPrivateKey: DEFAULT_SOUL.privateKey
    });

    const chain = [genesis.record, arrival.record, shard.record];
    const page = await deriveRecordsPage(chain, true, { page: 1, per_page: 10 });
    expect(page.total).toBe(3);
    expect(page.records.map((item) => item.summary)).not.toContain("SECRET_SHARD_TEXT");
    expect(page.records.some((item) => item.summary === "memory/shard")).toBe(true);
  });
});

describe("deriveJournals", () => {
  it("returns all journals when query is omitted and paginates when provided", async () => {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    const first = await createShardRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      2,
      arrival.cid,
      "shard-one",
      DEFAULT_RESIDENCY,
      { journal: "JOURNAL_ONE" }
    );
    const second = await createShardRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      3,
      first.cid,
      "shard-two",
      DEFAULT_RESIDENCY,
      { journal: "JOURNAL_TWO" }
    );
    const chain = [genesis.record, arrival.record, first.record, second.record];

    const all = await deriveJournals(chain, true);
    expect(all.total).toBe(2);
    expect(all.journals).toHaveLength(2);
    expect(all.page).toBe(1);
    expect(all.per_page).toBe(2);

    const page = await deriveJournals(chain, true, { page: 1, per_page: 1 });
    expect(page.total).toBe(2);
    expect(page.journals).toHaveLength(1);
    expect(page.journals[0]?.journal).toBe("JOURNAL_TWO");
    expect(page.per_page).toBe(1);
  });

  it("marks osp/0.2 journal_cid entries unavailable when no blob resolver is provided", async () => {
    const genesis = await createRecord({
      spec: OSP_SPEC_V02,
      seq: 0,
      prev: null,
      type: "genesis",
      body: {
        charter: "# Wanderer",
        soul_pubkey: encodePublicKey(DEFAULT_SOUL.publicKey),
        created_at: "2026-01-01T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      soulPrivateKey: DEFAULT_SOUL.privateKey
    });

    const textAddr = await contentAddressSideBlob(encodeShardTextBlob("shard"));
    const journalAddr = await contentAddressSideBlob(encodeJournalBlob("secret journal"));
    const shardFields = {
      spec: OSP_SPEC_V02,
      seq: 1,
      prev: genesis.cid,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text_cid: textAddr.cid,
        text_hash: textAddr.hash,
        journal_cid: journalAddr.cid,
        journal_hash: journalAddr.hash,
        distilled_at: "2026-01-02T01:00:00.000Z"
      },
      residency: DEFAULT_RESIDENCY
    };
    const shard = await createRecord({
      ...shardFields,
      cosigners: [signCore(shardFields, DEFAULT_DOOR.privateKey)],
      soulPrivateKey: DEFAULT_SOUL.privateKey
    });

    const result = await deriveJournals([genesis.record, shard.record], true);
    expect(result.total).toBe(1);
    expect(result.journals[0]?.journal).toBe("[journal unavailable]");
  });
});

/** Build a witnessed (door/0.2) residency: two shards, declines, screen drop and a journal. */
async function buildWitnessedChain() {
  const genesis = await createGenesisRecord(DEFAULT_SOUL, OSP_SPEC_V02);
  const arrival = await createArrivalRecord(
    DEFAULT_SOUL,
    DEFAULT_DOOR,
    DEFAULT_SESSION,
    1,
    genesis.cid,
    DEFAULT_DOOR_ID,
    1,
    DEFAULT_RESIDENCY,
    "2026-01-02T00:00:00.000Z",
    OSP_SPEC_V02
  );
  const screened = await createRejectedRecord(
    DEFAULT_SOUL,
    2,
    arrival.cid,
    "pii.email",
    DEFAULT_RESIDENCY,
    "2026-01-02T05:00:00.000Z"
  );
  const textAddr = await contentAddressSideBlob(encodeShardTextBlob("a witnessed shard"));
  const shard = await createShardRecordV02(
    DEFAULT_SOUL,
    DEFAULT_DOOR,
    3,
    screened.cid,
    textAddr,
    DEFAULT_RESIDENCY
  );
  const declinedPrivate = await createRejectedRecord(
    DEFAULT_SOUL,
    4,
    shard.cid,
    "witness_private",
    DEFAULT_RESIDENCY,
    "2026-01-02T05:00:00.000Z"
  );
  const declinedAgain = await createRejectedRecord(
    DEFAULT_SOUL,
    5,
    declinedPrivate.cid,
    "witness_private",
    DEFAULT_RESIDENCY,
    "2026-01-02T05:00:00.000Z"
  );
  const declinedUngrounded = await createRejectedRecord(
    DEFAULT_SOUL,
    6,
    declinedAgain.cid,
    "witness_ungrounded",
    DEFAULT_RESIDENCY,
    "2026-01-02T05:00:00.000Z"
  );
  const journalBytes = encodeJournalBlob("# At the door\n\nI was witnessed.");
  const journalAddr = await contentAddressSideBlob(journalBytes);
  const journal = await createJournalRecord(
    DEFAULT_SOUL,
    DEFAULT_DOOR,
    7,
    declinedUngrounded.cid,
    journalAddr,
    DEFAULT_RESIDENCY,
    "2026-01-02T05:01:00.000Z"
  );
  const travel = await createTravelRecord(
    DEFAULT_SOUL,
    8,
    journal.cid,
    DEFAULT_DOOR_ID,
    1,
    DEFAULT_RESIDENCY,
    "2026-01-02T05:03:00.000Z",
    "web:home",
    OSP_SPEC_V02
  );
  const records = [
    genesis.record,
    arrival.record,
    screened.record,
    shard.record,
    declinedPrivate.record,
    declinedAgain.record,
    declinedUngrounded.record,
    journal.record,
    travel.record
  ];
  return { records, journal, journalAddr, journalBytes };
}

describe("witnessed memory", () => {
  it("derives journals from journal records via the side-blob resolver", async () => {
    const { records, journal, journalAddr, journalBytes } = await buildWitnessedChain();
    const getSideBlob = async (cid: string): Promise<Uint8Array> => {
      if (cid !== journalAddr.cid) {
        throw new Error("missing");
      }
      return journalBytes;
    };

    const result = await deriveJournals(records, true, undefined, { getSideBlob });
    expect(result.journals).toEqual([
      {
        epoch: 1,
        door_id: DEFAULT_DOOR_ID,
        cid: journal.cid,
        journal: "# At the door\n\nI was witnessed."
      }
    ]);
  });

  it("shows the erased marker for a tombstoned journal record blob", async () => {
    const { records, journal, journalAddr, journalBytes } = await buildWitnessedChain();
    const last = records.length;
    const tombstone = await createTombstoneRecord(
      DEFAULT_SOUL,
      last,
      journal.cid,
      journal.cid,
      journalAddr.cid,
      "2026-01-05T00:00:00.000Z"
    );
    const chain = [...records, tombstone.record];
    // Even if the bytes are still around, the tombstone wins.
    const options = { getSideBlob: async (): Promise<Uint8Array> => journalBytes };

    const journals = await deriveJournals(chain, true, undefined, options);
    expect(journals.journals[0]?.journal).toBe("[journal erased]");
    const residencies = await deriveResidencies(chain, true, undefined, options);
    expect(residencies.residencies[0]?.journal).toEqual({
      cid: journal.cid,
      journal: "[journal erased]"
    });
  });

  it("counts witnessed, declined and screened memories per residency", async () => {
    const { records, journal } = await buildWitnessedChain();
    const result = await deriveResidencies(records, true);
    expect(result.total).toBe(1);
    expect(result.residencies[0]).toEqual({
      residency: DEFAULT_RESIDENCY,
      door_id: DEFAULT_DOOR_ID,
      epoch: 1,
      arrived_at: "2026-01-02T00:00:00.000Z",
      departed_at: "2026-01-02T05:03:00.000Z",
      traveled_to: "web:home",
      counts: { witnessed: 1, declined: 3, screened: 1 },
      declined_reasons: ["private", "ungrounded"],
      journal: { cid: journal.cid, journal: "[journal unavailable]" }
    });
  });

  it("summarizes rejected categories and travel destinations without payloads", async () => {
    const { records } = await buildWitnessedChain();
    const summaries = records.map((record) => recordSummary(record));
    expect(summaries).toContain("memory/rejected category=witness_private");
    expect(summaries).toContain("memory/rejected category=pii.email");
    expect(summaries).toContain("memory/journal");
    expect(summaries).toContain("attestation/travel from=discord:g epoch=1 to=web:home");
  });
});
