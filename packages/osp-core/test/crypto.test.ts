import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/canonical.js";
import { CidSchema, computeCid, isValidCid } from "../src/crypto/cid.js";
import { generateKeypair, sign, verify } from "../src/crypto/ed25519.js";

describe("ed25519", () => {
  it("signs and verifies a message roundtrip", () => {
    const { privateKey, publicKey } = generateKeypair();
    const message = new TextEncoder().encode("soulchain record payload");

    const signature = sign(message, privateKey);
    expect(signature.length).toBe(64);
    expect(verify(message, signature, publicKey)).toBe(true);
  });

  it("fails verification with the wrong public key", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const message = new TextEncoder().encode("tamper test");

    const signature = sign(message, alice.privateKey);
    expect(verify(message, signature, bob.publicKey)).toBe(false);
  });
});

describe("computeCid", () => {
  const sampleRecord = {
    body: { kind: "shard", text: "I remember the rain." },
    cosigners: [],
    prev: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    residency: "door:discord:guild123/epoch:77",
    seq: 42,
    sig: "abc",
    spec: "osp/0.1",
    type: "memory"
  };

  it("returns a CIDv1 base32 string for dag-json codec", async () => {
    const cid = await computeCid(sampleRecord);
    // dag-json (0x0129) + sha2-256 yields base32 CIDs starting with "bagu", not "bafy" (dag-pb).
    expect(cid.startsWith("bagu")).toBe(true);
  });

  it("returns the same CID for logically equal objects with different key order", async () => {
    const shuffled = {
      type: "memory",
      sig: "abc",
      spec: "osp/0.1",
      seq: 42,
      prev: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      residency: "door:discord:guild123/epoch:77",
      cosigners: [],
      body: { text: "I remember the rain.", kind: "shard" }
    };

    const cidA = await computeCid(sampleRecord);
    const cidB = await computeCid(shuffled);
    expect(cidA).toBe(cidB);
    expect(canonicalize(sampleRecord)).toEqual(canonicalize(shuffled));
  });

  it("returns different CIDs for different objects", async () => {
    const cidA = await computeCid(sampleRecord);
    const cidB = await computeCid({ ...sampleRecord, seq: 43 });
    expect(cidA).not.toBe(cidB);
  });
});

describe("isValidCid", () => {
  const sampleRecord = {
    body: { kind: "shard", text: "I remember the rain." },
    cosigners: [],
    prev: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    residency: "door:discord:guild123/epoch:77",
    seq: 42,
    sig: "abc",
    spec: "osp/0.1",
    type: "memory"
  };

  it("accepts a real CID from computeCid", async () => {
    const cid = await computeCid(sampleRecord);
    expect(isValidCid(cid)).toBe(true);
    expect(CidSchema.safeParse(cid).success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidCid("")).toBe(false);
    expect(CidSchema.safeParse("").success).toBe(false);
  });

  it("rejects path traversal and absolute paths", () => {
    expect(isValidCid("../etc/passwd")).toBe(false);
    expect(isValidCid("/etc/passwd")).toBe(false);
  });

  it("rejects wrong length (51-char bagu prefix fake)", () => {
    const shortFake = "bagu" + "a".repeat(47);
    expect(shortFake.length).toBe(51);
    expect(isValidCid(shortFake)).toBe(false);
  });

  it("rejects invalid base32 alphabet characters (0, 1, 8, 9)", () => {
    const withZero = "bagu" + "0".repeat(57);
    const withOne = "bagu" + "1".repeat(57);
    const withEight = "bagu" + "8".repeat(57);
    const withNine = "bagu" + "9".repeat(57);
    expect(isValidCid(withZero)).toBe(false);
    expect(isValidCid(withOne)).toBe(false);
    expect(isValidCid(withEight)).toBe(false);
    expect(isValidCid(withNine)).toBe(false);
  });

  it("rejects wrong prefix (dag-pb bafy style short fake)", () => {
    const dagPbFake = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(isValidCid(dagPbFake)).toBe(false);
  });
});
