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

import { deriveJournals, deriveRecordsPage, deriveState } from "../src/derive.js";
import {
  createArrivalRecord,
  createDepartureRecord,
  createGenesisRecord,
  createShardRecord,
  createSleepRecord,
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
      epoch: null
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
      epoch: 1
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
