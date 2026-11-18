/**
 * Incremental `ChainVerifier` (browser entry) matches `verifyRecords`.
 *
 * Every split index stops after the prefix, checks that result (and the
 * verifier's head and tombstoned blobs), then feeds a fresh JSON copy of
 * the tail. Signatures are real Ed25519 from the fixed test keys — never mocked.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ChainVerifier,
  RecordSchema,
  computeCid,
  decodePublicKey,
  verifyRecords,
  type ChainFailure,
  type VerifyChainOptions,
  type VerifyChainResult
} from "../src/browser.js";
import {
  createRecord,
  decodeSignature,
  encodePublicKey,
  encodeSignature,
  signCore,
  type OspRecord
} from "../src/index.js";
import { DOOR, SESSION, SOUL } from "./helpers/fixed-keys.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsDir = path.resolve(here, "../../../spec/osp/vectors");

const DOOR_ID = "discord:g";
const RESIDENCY = `door:${DOOR_ID}/epoch:1`;

const HEARTBEAT_AT = [
  "2026-01-02T00:10:00.000Z",
  "2026-01-02T00:20:00.000Z",
  "2026-01-02T00:30:00.000Z",
  "2026-01-02T00:40:00.000Z"
] as const;

/** Door keys the fixed arrival and heartbeat cosigners verify against. */
function doorOptions(): VerifyChainOptions {
  return { doorPublicKeys: { [DOOR_ID]: DOOR.publicKey } };
}

/** Signed genesis from the fixed soul key. */
async function genesisRecord(): Promise<{ record: OspRecord; cid: string }> {
  return createRecord({
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer",
      soul_pubkey: encodePublicKey(SOUL.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: SOUL.privateKey
  });
}

/** Signed arrival; the Door cosignature is over the real core bytes. */
async function arrivalRecord(
  seq: number,
  prev: string
): Promise<{ record: OspRecord; cid: string }> {
  const fields = {
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: "pop/0.1" as const,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: encodePublicKey(SESSION.publicKey),
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY
  };
  return createRecord({
    ...fields,
    cosigners: [signCore(fields, DOOR.privateKey)],
    soulPrivateKey: SOUL.privateKey
  });
}

/** Signed heartbeat continuing the open arrival session. */
async function heartbeatRecord(
  seq: number,
  prev: string,
  at: string
): Promise<{ record: OspRecord; cid: string }> {
  const fields = {
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "heartbeat" as const,
      pop_version: "pop/0.1" as const,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: encodePublicKey(SESSION.publicKey),
      at
    },
    residency: RESIDENCY
  };
  return createRecord({
    ...fields,
    cosigners: [signCore(fields, DOOR.privateKey)],
    soulPrivateKey: SOUL.privateKey
  });
}

/**
 * Genesis, arrival, and four heartbeats.
 * `brokenPrev` re-signs the last heartbeat against `genesisCid` instead of the real head.
 */
async function buildChain(brokenPrev: boolean): Promise<OspRecord[]> {
  const genesis = await genesisRecord();
  const arrival = await arrivalRecord(1, genesis.cid);
  const records: OspRecord[] = [genesis.record, arrival.record];
  let prev = arrival.cid;
  let seq = 2;
  for (let index = 0; index < HEARTBEAT_AT.length; index += 1) {
    const at = HEARTBEAT_AT[index];
    if (at === undefined) {
      throw new Error("heartbeat timestamp missing");
    }
    const last = index === HEARTBEAT_AT.length - 1;
    const link = brokenPrev && last ? genesis.cid : prev;
    const beat = await heartbeatRecord(seq, link, at);
    records.push(beat.record);
    prev = beat.cid;
    seq += 1;
  }
  return records;
}

/**
 * Re-sign seq 3 over the genesis CID and leave the later heartbeats in place.
 * Those later records still name the original seq 3 CID, so verification
 * reports `broken_prev_link` at seq 3 and a cascade on the next record.
 * Splits after seq 3 put the failure in the prefix while the tail continues.
 */
async function chainWithMiddleBrokenPrev(): Promise<OspRecord[]> {
  const records = await buildChain(false);
  const middleSeq = 3;
  const genesis = records[0];
  const target = records[middleSeq];
  if (genesis === undefined || target === undefined) {
    throw new Error("chain is shorter than the middle break");
  }
  if (target.seq !== middleSeq) {
    throw new Error(`expected seq ${String(middleSeq)} at index ${String(middleSeq)}`);
  }
  const at = HEARTBEAT_AT[middleSeq - 2];
  if (at === undefined) {
    throw new Error("heartbeat timestamp missing");
  }
  const genesisCid = await computeCid(genesis);
  if (target.prev === genesisCid) {
    throw new Error("middle prev already points at genesis");
  }
  const broken = await heartbeatRecord(target.seq, genesisCid, at);
  return [...records.slice(0, middleSeq), broken.record, ...records.slice(middleSeq + 1)];
}

/**
 * Replace the last record's soul signature with the same bytes, one bit flipped.
 * The encoding stays a 64-byte signature; verification must reject it.
 */
function flipLastSoulSignature(records: readonly OspRecord[]): unknown[] {
  const last = records[records.length - 1];
  if (last === undefined) {
    throw new Error("chain is empty");
  }
  const bytes = decodeSignature(last.sig);
  const flipped = new Uint8Array(bytes);
  const first = flipped[0];
  if (first === undefined) {
    throw new Error("soul signature is empty");
  }
  flipped[0] = first ^ 1;
  const tampered: unknown[] = records.slice(0, -1);
  tampered.push({ ...last, sig: encodeSignature(flipped) });
  return tampered;
}

/** Caller-built result. `ChainVerifier` does not accumulate one. */
function resultSoFar(
  failures: readonly ChainFailure[],
  head: ChainVerifier["head"]
): VerifyChainResult {
  if (failures.length > 0) {
    return { valid: false, failures: [...failures] };
  }
  return { valid: true, head };
}

/**
 * Head a client would keep after admitting these records: the last schema-valid
 * record. Chain failures still advance the head; a schema failure does not.
 */
async function admittedHead(records: readonly unknown[]): Promise<ChainVerifier["head"]> {
  let head: ChainVerifier["head"] = null;
  for (const raw of records) {
    const parsed = RecordSchema.safeParse(raw);
    if (!parsed.success) {
      continue;
    }
    head = { cid: await computeCid(parsed.data), seq: parsed.data.seq };
  }
  return head;
}

/** Blob CIDs a tombstone record names. Independent of {@link ChainVerifier}. */
function tombstoneBlobCids(records: readonly unknown[]): Set<string> {
  const blobs = new Set<string>();
  for (const raw of records) {
    const parsed = RecordSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== "tombstone") {
      continue;
    }
    blobs.add(parsed.data.body.blob_cid);
  }
  return blobs;
}

/** Sorted copy so set equality does not depend on insertion order. */
function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

/**
 * A second fetch: new objects, no shared references with the prefix records.
 * Plain JSON, which is what `GET /chain/export` returns.
 */
function freshRecords(records: readonly unknown[]): unknown[] {
  const parsed: unknown = JSON.parse(JSON.stringify(records));
  if (!Array.isArray(parsed)) {
    throw new Error("records did not round-trip as an array");
  }
  return parsed;
}

/**
 * Admit the prefix, check it, then admit a fresh copy of the tail.
 * Failing records are still committed, which is what {@link verifyRecords} does.
 */
async function verifySplit(
  records: readonly unknown[],
  splitAt: number,
  options: VerifyChainOptions
): Promise<VerifyChainResult> {
  const verifier = new ChainVerifier(options);
  const failures: ChainFailure[] = [];
  const prefix = records.slice(0, splitAt);
  for (const raw of prefix) {
    const step = await verifier.evaluate(raw);
    failures.push(...step.failures);
    step.commit();
  }

  const label = `split ${String(splitAt)} prefix`;
  expect(resultSoFar(failures, verifier.head), label).toEqual(await verifyRecords(prefix, options));
  expect(verifier.head, `${label} head`).toEqual(await admittedHead(prefix));
  expect(sortedIds(verifier.tombstonedBlobCids()), `${label} tombstones`).toEqual(
    sortedIds(tombstoneBlobCids(prefix))
  );

  for (const raw of freshRecords(records.slice(splitAt))) {
    const step = await verifier.evaluate(raw);
    failures.push(...step.failures);
    step.commit();
  }
  return resultSoFar(failures, verifier.head);
}

/** Every prefix length `0..records.length` must match one-shot verification. */
async function expectEverySplitMatches(
  records: readonly unknown[],
  options: VerifyChainOptions
): Promise<VerifyChainResult> {
  const whole = await verifyRecords(records, options);
  for (let splitAt = 0; splitAt <= records.length; splitAt += 1) {
    const split = await verifySplit(records, splitAt, options);
    expect(split, `split ${String(splitAt)} of ${String(records.length)}`).toEqual(whole);
  }
  return whole;
}

type LoadedVector = {
  expected: string;
  records: unknown[];
  doorPublicKeys: NonNullable<VerifyChainOptions["doorPublicKeys"]>;
};

/** Read one committed vector. Door keys are decoded, not trusted as raw strings. */
function loadVector(filename: string): LoadedVector {
  const parsed: unknown = JSON.parse(readFileSync(path.join(vectorsDir, filename), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${filename}: vector root must be an object`);
  }
  const expected: unknown = Reflect.get(parsed, "expected");
  const records: unknown = Reflect.get(parsed, "records");
  const doorRaw: unknown = Reflect.get(parsed, "doorPublicKeys");
  if (typeof expected !== "string" || !Array.isArray(records)) {
    throw new Error(`${filename}: expected and records are required`);
  }
  if (typeof doorRaw !== "object" || doorRaw === null || Array.isArray(doorRaw)) {
    throw new Error(`${filename}: doorPublicKeys must be an object`);
  }
  const doorPublicKeys: Record<string, Uint8Array> = {};
  for (const [doorId, encoded] of Object.entries(doorRaw)) {
    if (typeof encoded !== "string") {
      throw new Error(`${filename}: door key ${doorId} must be a string`);
    }
    doorPublicKeys[doorId] = decodePublicKey(encoded);
  }
  return { expected, records, doorPublicKeys };
}

describe("ChainVerifier split equals verifyRecords", () => {
  it("matches a valid fixed-key chain at every index", async () => {
    const records = await buildChain(false);
    expect(records.length).toBeGreaterThan(1);
    const whole = await expectEverySplitMatches(records, doorOptions());
    expect(whole.valid).toBe(true);
    if (!whole.valid) {
      throw new Error("fixed-key chain must verify");
    }
    expect(whole.head).not.toBeNull();
  });

  it("matches when the tail prev link is re-signed against an earlier record", async () => {
    const records = await buildChain(true);
    const whole = await expectEverySplitMatches(records, doorOptions());
    if (whole.valid) {
      throw new Error("broken prev chain must fail");
    }
    const lastSeq = records.length - 1;
    expect(
      whole.failures.some(
        (failure) => failure.rule === "broken_prev_link" && failure.seq === lastSeq
      )
    ).toBe(true);
  });

  it("matches when a broken prev sits in the middle and the tail continues", async () => {
    const records = await chainWithMiddleBrokenPrev();
    const middleSeq = 3;
    expect(records.length).toBeGreaterThan(middleSeq + 1);
    const whole = await expectEverySplitMatches(records, doorOptions());
    if (whole.valid) {
      throw new Error("middle broken prev must fail");
    }
    expect(
      whole.failures.some(
        (failure) => failure.rule === "broken_prev_link" && failure.seq === middleSeq
      )
    ).toBe(true);
    expect(
      whole.failures.some(
        (failure) => failure.rule === "broken_prev_link" && failure.seq > middleSeq
      )
    ).toBe(true);
  });

  it("matches when the tail soul signature is a flipped real signature", async () => {
    const records = flipLastSoulSignature(await buildChain(false));
    const whole = await expectEverySplitMatches(records, doorOptions());
    if (whole.valid) {
      throw new Error("flipped signature must fail");
    }
    const lastSeq = records.length - 1;
    expect(
      whole.failures.some((failure) => failure.rule === "bad_soul_sig" && failure.seq === lastSeq)
    ).toBe(true);
  });

  it.each(["valid-mini-chain.json", "broken-prev-link.json", "bad-soul-sig.json"])(
    "matches fixture %s at every index",
    async (filename) => {
      const vector = loadVector(filename);
      expect(vector.records.length).toBeGreaterThan(1);
      const whole = await expectEverySplitMatches(vector.records, {
        doorPublicKeys: vector.doorPublicKeys
      });
      if (vector.expected === "valid") {
        expect(whole.valid, filename).toBe(true);
        return;
      }
      if (whole.valid) {
        throw new Error(`${filename}: expected ${vector.expected}`);
      }
      expect(whole.failures[0]?.rule, filename).toBe(vector.expected);
    }
  );
});
