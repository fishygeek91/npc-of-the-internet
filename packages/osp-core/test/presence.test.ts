/**
 * Newest-first presence, plus the per-epoch arrival key the porch uses
 * after a stay has closed.
 */
import { describe, expect, it } from "vitest";

import { encodePublicKey } from "../src/encoding/base64url.js";
import {
  arrivalForEpoch as arrivalFromBrowser,
  arrivalsForDoor as arrivalsFromBrowser,
  scanPresence as scanFromBrowser
} from "../src/browser.js";
import {
  arrivalForEpoch as arrivalFromRoot,
  arrivalsForDoor as arrivalsFromRoot,
  scanPresence as scanFromRoot
} from "../src/index.js";
import { arrivalForEpoch, arrivalsForDoor, scanPresence } from "../src/presence.js";
import { createRecord, signCore, type CreateRecordFields, type OspRecord } from "../src/record.js";
import { DOOR, OTHER_SESSION, SESSION, SOUL } from "./helpers/fixed-keys.js";

const HOME = "web:home";
const GUILD = "discord:guild";
const HOME_KEY = encodePublicKey(SESSION.publicKey);
const OTHER_KEY = encodePublicKey(OTHER_SESSION.publicKey);
const POP = "pop/0.1" as const;

/** `door:<id>/epoch:<n>`, the residency string the envelope requires. */
function residency(doorId: string, epoch: number): string {
  return `door:${doorId}/epoch:${String(epoch)}`;
}

/** Signed records in append order. The scan does not check the signatures. */
class Chain {
  readonly records: OspRecord[] = [];
  private prev: string | null = null;

  async add(
    type: CreateRecordFields["type"],
    body: CreateRecordFields["body"],
    stay: string | null,
    witnessed = false
  ): Promise<void> {
    const fields = {
      seq: this.records.length,
      prev: this.prev,
      type,
      body,
      residency: stay
    };
    const created = await createRecord({
      ...fields,
      cosigners: witnessed ? [signCore(fields, DOOR.privateKey)] : [],
      soulPrivateKey: SOUL.privateKey
    });
    this.records.push(created.record);
    this.prev = created.cid;
  }
}

async function openChain(): Promise<Chain> {
  const chain = new Chain();
  await chain.add(
    "genesis",
    {
      charter: "charter",
      soul_pubkey: encodePublicKey(SOUL.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    null
  );
  return chain;
}

async function witnessed(
  chain: Chain,
  body: CreateRecordFields["body"],
  doorId: string,
  epoch: number
): Promise<void> {
  await chain.add("attestation", body, residency(doorId, epoch), true);
}

/** Arrival or heartbeat. The heartbeat key must not replace the arrival key. */
async function sessionAttest(
  chain: Chain,
  kind: "arrival" | "heartbeat",
  doorId: string,
  epoch: number,
  at: string,
  sessionPubkey: string
): Promise<void> {
  await witnessed(
    chain,
    { kind, pop_version: POP, door_id: doorId, epoch, session_pubkey: sessionPubkey, at },
    doorId,
    epoch
  );
}

async function depart(chain: Chain, doorId: string, epoch: number, at: string): Promise<void> {
  await witnessed(
    chain,
    { kind: "departure", pop_version: POP, door_id: doorId, epoch, at },
    doorId,
    epoch
  );
}

async function shard(chain: Chain): Promise<void> {
  await chain.add(
    "memory",
    { kind: "shard", text: "a kept line", distilled_at: "2026-01-02T01:00:00.000Z" },
    residency(HOME, 1),
    true
  );
}

function present(doorId: string, epoch: number, index: number, at: string) {
  return { status: "present" as const, doorId, epoch, index, at };
}

function traveling(epoch: number, index: number, at: string) {
  return { status: "traveling" as const, epoch, index, at };
}

function stayed(doorId: string, epoch: number, sessionPubkey: string) {
  return { doorId, epoch, sessionPubkey };
}

describe("scanPresence", () => {
  it("is the same function on the package root and the browser entry", () => {
    expect(scanFromRoot).toBe(scanPresence);
    expect(scanFromBrowser).toBe(scanPresence);
    expect(arrivalFromRoot).toBe(arrivalForEpoch);
    expect(arrivalFromBrowser).toBe(arrivalForEpoch);
    expect(arrivalsFromRoot).toBe(arrivalsForDoor);
    expect(arrivalsFromBrowser).toBe(arrivalsForDoor);
  });

  it("sleeps when the chain has no attestation, including a memory with no stay", async () => {
    expect(scanPresence([])).toEqual({ status: "sleeping", asOf: null, index: null });
    const chain = await openChain();
    expect(scanPresence(chain.records)).toEqual({ status: "sleeping", asOf: null, index: null });
    await shard(chain);
    expect(scanPresence(chain.records)).toEqual({ status: "sleeping", asOf: null, index: null });
  });

  it("treats the newest arrival or heartbeat as present and skips other records", async () => {
    const chain = await openChain();
    await sessionAttest(chain, "arrival", HOME, 1, "2026-01-02T00:00:00.000Z", HOME_KEY);
    await shard(chain);
    expect(scanPresence(chain.records)).toEqual(present(HOME, 1, 1, "2026-01-02T00:00:00.000Z"));
    await sessionAttest(chain, "heartbeat", HOME, 1, "2026-01-02T02:00:00.000Z", OTHER_KEY);
    expect(scanPresence(chain.records)).toEqual(present(HOME, 1, 3, "2026-01-02T02:00:00.000Z"));
  });

  it("sleeps when sleep is newer than every attestation, and a later attestation clears it", async () => {
    const chain = await openChain();
    await sessionAttest(chain, "arrival", GUILD, 1, "2026-01-02T00:00:00.000Z", OTHER_KEY);
    await chain.add(
      "sleep",
      {
        reason: "balance_below_threshold",
        balance: "0",
        threshold: "1",
        as_of: "2026-01-02T03:00:00.000Z"
      },
      residency(GUILD, 1)
    );
    expect(scanPresence(chain.records)).toEqual({
      status: "sleeping",
      asOf: "2026-01-02T03:00:00.000Z",
      index: 2
    });
    await sessionAttest(chain, "heartbeat", GUILD, 1, "2026-01-02T04:00:00.000Z", OTHER_KEY);
    expect(scanPresence(chain.records)).toEqual(present(GUILD, 1, 3, "2026-01-02T04:00:00.000Z"));
  });

  it("travels on departure, travel from_epoch, and handover depart_epoch", async () => {
    const departed = await openChain();
    await sessionAttest(departed, "arrival", HOME, 1, "2026-01-02T00:00:00.000Z", HOME_KEY);
    await depart(departed, HOME, 1, "2026-01-02T02:00:00.000Z");
    expect(scanPresence(departed.records)).toEqual(traveling(1, 2, "2026-01-02T02:00:00.000Z"));

    const moving = await openChain();
    await moving.add(
      "attestation",
      {
        kind: "travel",
        pop_version: POP,
        from_door_id: HOME,
        from_epoch: 4,
        at: "2026-01-04T00:00:00.000Z"
      },
      residency(HOME, 4)
    );
    expect(scanPresence(moving.records)).toEqual(traveling(4, 1, "2026-01-04T00:00:00.000Z"));

    const handover = await openChain();
    await handover.add(
      "attestation",
      {
        kind: "handover",
        pop_version: POP,
        depart_door_id: HOME,
        arrive_door_id: GUILD,
        depart_epoch: 3,
        arrive_epoch: 9,
        at: "2026-01-05T00:00:00.000Z"
      },
      residency(HOME, 3)
    );
    expect(scanPresence(handover.records)).toEqual(traveling(3, 1, "2026-01-05T00:00:00.000Z"));
  });
});

describe("arrivalForEpoch", () => {
  it("uses the first arrival key for that epoch, not a later heartbeat or a second arrival", async () => {
    const chain = await openChain();
    await sessionAttest(chain, "arrival", HOME, 1, "2026-01-02T00:00:00.000Z", HOME_KEY);
    await sessionAttest(chain, "heartbeat", HOME, 1, "2026-01-02T02:00:00.000Z", OTHER_KEY);
    expect(arrivalForEpoch(chain.records, HOME, 1)).toEqual(stayed(HOME, 1, HOME_KEY));
    expect(arrivalForEpoch(chain.records, GUILD, 1)).toBeNull();

    const duplicate = await openChain();
    await sessionAttest(duplicate, "arrival", HOME, 1, "2026-01-02T00:00:00.000Z", HOME_KEY);
    await sessionAttest(duplicate, "arrival", HOME, 1, "2026-01-02T01:00:00.000Z", OTHER_KEY);
    expect(scanPresence(duplicate.records)).toMatchObject({ status: "present", index: 2 });
    expect(arrivalForEpoch(duplicate.records, HOME, 1)).toEqual(stayed(HOME, 1, HOME_KEY));
    expect(arrivalsForDoor(duplicate.records, HOME)).toEqual([
      stayed(HOME, 1, HOME_KEY),
      stayed(HOME, 1, OTHER_KEY)
    ]);
  });

  it("returns null when the epoch has a heartbeat and no arrival", async () => {
    const chain = await openChain();
    await sessionAttest(chain, "heartbeat", HOME, 1, "2026-01-02T02:00:00.000Z", HOME_KEY);
    expect(scanPresence(chain.records)).toMatchObject({
      status: "present",
      doorId: HOME,
      epoch: 1
    });
    expect(arrivalForEpoch(chain.records, HOME, 1)).toBeNull();
  });

  it("still finds a past epoch after the Wanderer is present at another door", async () => {
    const chain = await openChain();
    await sessionAttest(chain, "arrival", HOME, 1, "2026-01-02T00:00:00.000Z", HOME_KEY);
    await depart(chain, HOME, 1, "2026-01-02T02:00:00.000Z");
    expect(scanPresence(chain.records)).toEqual(traveling(1, 2, "2026-01-02T02:00:00.000Z"));
    await sessionAttest(chain, "arrival", GUILD, 2, "2026-01-03T00:00:00.000Z", OTHER_KEY);

    expect(scanPresence(chain.records)).toEqual(present(GUILD, 2, 3, "2026-01-03T00:00:00.000Z"));
    expect(arrivalForEpoch(chain.records, HOME, 1)).toEqual(stayed(HOME, 1, HOME_KEY));
    expect(arrivalForEpoch(chain.records, HOME, 2)).toBeNull();
    expect(arrivalForEpoch(chain.records, GUILD, 1)).toBeNull();
    expect(arrivalForEpoch(chain.records, GUILD, 2)).toEqual(stayed(GUILD, 2, OTHER_KEY));
    expect(arrivalsForDoor(chain.records, HOME)).toEqual([stayed(HOME, 1, HOME_KEY)]);
    expect(arrivalsForDoor(chain.records, GUILD)).toEqual([stayed(GUILD, 2, OTHER_KEY)]);
  });
});
