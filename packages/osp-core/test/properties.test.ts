import fc, { type JsonValue } from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/canonical.js";
import { computeCid } from "../src/crypto/cid.js";
import {
  decodeBase64Url,
  decodeSignature,
  encodeBase64Url,
  encodeSignature
} from "../src/encoding/base64url.js";
import { EncodingError } from "../src/errors.js";
import {
  createRecord,
  encodePublicKey,
  signCore,
  verifyRecords,
  type OspRecord
} from "../src/index.js";
import { DOOR, SESSION, SOUL } from "./helpers/fixed-keys.js";

/** Fixed seed so every CI run replays the same cases. */
const SEED = 20261117;
const DOOR_ID = "discord:g";
const RESIDENCY = `door:${DOOR_ID}/epoch:1`;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * `fc.jsonValue()` omits NaN and infinities. `__proto__` keys are outside
 * canonicalize's domain (see canonical.test.ts), and unicode is enabled
 * because the default arbitrary is ASCII-only.
 */
const jsonDomain = fc
  .jsonValue({ maxDepth: 3, noUnicodeString: false })
  .filter((value) => !hasOwnProtoKey(value));

/** fast-check options: one seed, bounded runs. */
function runs(numRuns: number): { seed: number; numRuns: number } {
  return { seed: SEED, numRuns };
}

/** True when an own `__proto__` key appears at any depth. */
function hasOwnProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasOwnProtoKey(item));
  if (typeof value !== "object" || value === null) return false;
  if (Object.getOwnPropertyNames(value).includes("__proto__")) return true;
  return Object.getOwnPropertyNames(value).some((key) => hasOwnProtoKey(Reflect.get(value, key)));
}

/** Byte-for-byte equality. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** True for a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy `bytes` with one bit flipped. Indexes wrap. */
function flipByteBit(bytes: Uint8Array, byteIndex: number, bit: number): Uint8Array {
  if (bytes.length === 0) throw new Error("cannot flip an empty byte string");
  const next = new Uint8Array(bytes);
  const index = byteIndex % next.length;
  const current = next[index];
  if (current === undefined) throw new Error("byte index out of range");
  next[index] = current ^ (1 << (bit % 8));
  return next;
}

/** Flip one UTF-8 bit, or the low bit of a code unit when that is not UTF-8. */
function flipUtf8Bit(value: string, byteIndex: number, bit: number): string {
  if (value.length === 0) throw new Error("cannot flip an empty string");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      flipByteBit(new TextEncoder().encode(value), byteIndex, bit)
    );
    if (text !== value) return text;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
  }
  const units = Array.from(value);
  const index = byteIndex % units.length;
  const unit = units[index];
  if (unit === undefined) throw new Error("string index out of range");
  const code = unit.codePointAt(0);
  if (code === undefined) throw new Error("missing code point");
  units[index] = String.fromCodePoint(code ^ 1);
  const text = units.join("");
  if (text === value) throw new Error("bit flip did not change the string");
  return text;
}

/** Reverse object keys at every depth. Array order stays put. */
function reverseKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => reverseKeys(item));
  if (typeof value !== "object" || value === null) return value;
  const next: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).reverse()) {
    const child = value[key];
    if (child === undefined) throw new Error(`json object key ${key} has no value`);
    next[key] = reverseKeys(child);
  }
  return next;
}

/** UTF-8 JSON parse, or null when the bytes are not JSON text. */
function tryParseJson(bytes: Uint8Array): unknown | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value;
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Flip the first non-empty string leaf. */
function flipFirstString(
  value: unknown,
  byteIndex: number,
  bit: number,
  state: { done: boolean }
): unknown {
  if (state.done) return value;
  if (typeof value === "string") {
    if (value.length === 0) return value;
    state.done = true;
    return flipUtf8Bit(value, byteIndex, bit);
  }
  if (Array.isArray(value)) {
    return value.map((item) => flipFirstString(item, byteIndex, bit, state));
  }
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(value))
    next[key] = flipFirstString(value[key], byteIndex, bit, state);
  return next;
}

/**
 * Flip one canonical body bit. If that is not a different JSON value,
 * flip a string leaf so the signed bytes still change.
 */
function mutateBody(body: unknown, byteIndex: number, bit: number): unknown {
  const canonical = canonicalize(body);
  const parsed = tryParseJson(flipByteBit(canonical, byteIndex, bit));
  if (parsed !== null) {
    try {
      if (!bytesEqual(canonicalize(parsed), canonical)) return parsed;
    } catch (error: unknown) {
      if (!(error instanceof EncodingError)) throw error;
    }
  }
  const state = { done: false };
  const next = flipFirstString(body, byteIndex, bit, state);
  if (!state.done) throw new Error("body has no string leaf to flip");
  if (bytesEqual(canonicalize(body), canonicalize(next))) {
    throw new Error("body bit flip did not change canonical bytes");
  }
  return next;
}

/** Clone a record and replace one field. */
function withField(record: OspRecord, field: "sig" | "body" | "prev", value: unknown): unknown {
  const cloned: unknown = structuredClone(record);
  if (!isRecord(cloned)) throw new Error("structuredClone did not return an object");
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(cloned)) next[key] = cloned[key];
  next[field] = value;
  return next;
}

/** True when decodeBase64Url throws EncodingError. */
function rejectsBase64Url(encoded: string): boolean {
  try {
    decodeBase64Url(encoded);
    return false;
  } catch (error: unknown) {
    return error instanceof EncodingError;
  }
}

/** Real Ed25519 signatures: genesis, arrival, shard, drift. */
async function fixedMiniChain(): Promise<OspRecord[]> {
  const genesis = await createRecord({
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
  const arrivalFields = {
    seq: 1,
    prev: genesis.cid,
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
  const arrival = await createRecord({
    ...arrivalFields,
    cosigners: [signCore(arrivalFields, DOOR.privateKey)],
    soulPrivateKey: SOUL.privateKey
  });
  const shardFields = {
    seq: 2,
    prev: arrival.cid,
    type: "memory" as const,
    body: {
      kind: "shard" as const,
      text: "A committed shard memory.",
      distilled_at: "2026-01-02T01:00:00.000Z"
    },
    residency: RESIDENCY
  };
  const shard = await createRecord({
    ...shardFields,
    cosigners: [signCore(shardFields, DOOR.privateKey)],
    soulPrivateKey: SOUL.privateKey
  });
  const drift = await createRecord({
    seq: 3,
    prev: shard.cid,
    type: "drift",
    body: {
      summary: "I feel more patient after the long stay.",
      evidence: [shard.cid],
      effective_at: "2026-01-03T00:00:00.000Z"
    },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: SOUL.privateKey
  });
  return [genesis.record, arrival.record, shard.record, drift.record];
}

describe("fast-check invariants", () => {
  it("rejects one-bit flips of sig, body, or prev on a valid fixed-key chain", async () => {
    const records = await fixedMiniChain();
    const doorPublicKeys = { [DOOR_ID]: DOOR.publicKey };
    expect((await verifyRecords(records, { doorPublicKeys })).valid).toBe(true);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: records.length - 1 }),
        fc.constantFrom("sig", "body", "prev"),
        fc.integer({ min: 0, max: 512 }),
        fc.integer({ min: 0, max: 7 }),
        async (index, field, byteIndex, bit) => {
          const record = records[index];
          if (record === undefined) throw new Error("record index out of range");
          fc.pre(!(field === "prev" && record.prev === null));
          let replacement: unknown;
          if (field === "sig") {
            replacement = withField(
              record,
              "sig",
              encodeSignature(flipByteBit(decodeSignature(record.sig), byteIndex, bit))
            );
          } else if (field === "body") {
            replacement = withField(record, "body", mutateBody(record.body, byteIndex, bit));
          } else if (typeof record.prev === "string") {
            replacement = withField(record, "prev", flipUtf8Bit(record.prev, byteIndex, bit));
          } else {
            throw new Error("prev flip requires a string");
          }
          const mutated = records.map((item, itemIndex) =>
            itemIndex === index ? replacement : item
          );
          return (await verifyRecords(mutated, { doorPublicKeys })).valid === false;
        }
      ),
      runs(24)
    );
  }, 30_000);

  it("canonicalizes key order and repeats identically, including unicode, floats, and large ints", () => {
    const value = {
      é: "café 🌸",
      zeta: 0.1,
      big: Number.MAX_SAFE_INTEGER,
      unsafe: Number.MAX_SAFE_INTEGER + 2,
      nested: { "10": true, "2": -1.5 }
    };
    const once = canonicalize(value);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(once));
    expect(canonicalize(parsed)).toEqual(once);
    expect(
      canonicalize({
        nested: { "2": -1.5, "10": true },
        unsafe: Number.MAX_SAFE_INTEGER + 2,
        big: Number.MAX_SAFE_INTEGER,
        zeta: 0.1,
        é: "café 🌸"
      })
    ).toEqual(once);
    fc.assert(
      fc.property(jsonDomain, (sample) => {
        const bytes = canonicalize(sample);
        const again: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return (
          bytesEqual(bytes, canonicalize(again)) &&
          bytesEqual(bytes, canonicalize(reverseKeys(sample)))
        );
      }),
      runs(50)
    );
  });

  it("rejects non-finite numbers", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      { n: Number.NaN }
    ]) {
      expect(() => canonicalize(value)).toThrow(EncodingError);
    }
  });

  it("round-trips base64url and rejects + / = or length ≡ 1 (mod 4)", () => {
    expect(encodeBase64Url(new Uint8Array())).toBe("");
    expect(rejectsBase64Url("")).toBe(true);
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (bytes) =>
        bytesEqual(decodeBase64Url(encodeBase64Url(bytes)), bytes)
      ),
      runs(40)
    );
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 24 }),
        fc.constantFrom("+", "/", "="),
        (prefix, bad) => rejectsBase64Url(`${prefix}${bad}`)
      ),
      runs(40)
    );
    const alphabetChar = fc.integer({ min: 0, max: B64.length - 1 }).map((index) => {
      const char = B64.charAt(index);
      if (char.length !== 1) throw new Error("alphabet index out of range");
      return char;
    });
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 8 })
          .chain((blocks) =>
            fc.array(alphabetChar, { minLength: blocks * 4 + 1, maxLength: blocks * 4 + 1 })
          ),
        (chars) => {
          const encoded = chars.join("");
          if (encoded.length % 4 !== 1) throw new Error("length builder failed");
          return rejectsBase64Url(encoded);
        }
      ),
      runs(20)
    );
  });

  it("keeps CIDs stable under key permutation and distinct for distinct bytes", async () => {
    await fc.assert(
      fc.asyncProperty(
        jsonDomain,
        async (value) => (await computeCid(value)) === (await computeCid(reverseKeys(value)))
      ),
      runs(30)
    );
    await fc.assert(
      fc.asyncProperty(jsonDomain, jsonDomain, async (left, right) => {
        if (bytesEqual(canonicalize(left), canonicalize(right))) return true;
        return (await computeCid(left)) !== (await computeCid(right));
      }),
      runs(30)
    );
  });
});
