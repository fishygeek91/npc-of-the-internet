import { describe, expect, it } from "vitest";

import {
  buildUnsignedPinManifest,
  computeCid,
  computeManifestCid,
  decodePinManifest,
  decodeSignature,
  encodePinManifest,
  encodeSignature,
  encodeUnsignedPinManifest,
  generateKeypair,
  signPinManifest,
  verifyPinManifest,
  VerificationError,
  type OspRecord
} from "../src/index.js";

/** Minimal genesis-shaped record for deterministic test CIDs. */
function testRecord(seq: number, prev: string | null, marker: string): OspRecord {
  return {
    spec: "osp/0.1",
    seq,
    prev,
    residency: null,
    cosigners: [],
    sig: "N7-28uz8HA7Hi_4SFEx8_-FdJ53rk5jEGPuKuWnggMY0W4hFKELQU_E0IYAG7Sdfg7y4XXIfZUiHNGekFvQPBw",
    type: "genesis",
    body: {
      charter: `# ${marker}`,
      soul_pubkey: "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw",
      created_at: "2026-01-01T00:00:00.000Z"
    }
  };
}

async function testCid(seq: number, prev: string | null, marker: string): Promise<string> {
  return computeCid(testRecord(seq, prev, marker));
}

describe("pin manifest", () => {
  it("builds, signs, verifies, and computes CID", async () => {
    const soul = generateKeypair();
    const generatedAt = "2026-07-28T00:00:00Z";
    const genesisCid = await testCid(0, null, "genesis");
    const midCid = await testCid(1, genesisCid, "mid");
    const headCid = await testCid(2, midCid, "head");

    const unsigned = buildUnsignedPinManifest({
      headCid,
      genesisCid,
      recordCids: [genesisCid, midCid, headCid],
      seq: 2,
      generatedAt
    });

    expect(unsigned.prev_manifest).toBeUndefined();

    const signed = signPinManifest(unsigned, soul.privateKey);
    const verifyResult = await verifyPinManifest(signed, soul.publicKey);
    const expectedCid = await computeManifestCid(signed);
    expect(verifyResult.cid).toBe(expectedCid);
  });

  it("omits prev_manifest on the first manifest", async () => {
    const genesisCid = await testCid(0, null, "solo");
    const unsigned = buildUnsignedPinManifest({
      headCid: genesisCid,
      genesisCid,
      recordCids: [genesisCid],
      seq: 0,
      generatedAt: "2026-07-28T00:00:00Z"
    });

    expect(unsigned.prev_manifest).toBeUndefined();
    const encoded = new TextDecoder().decode(encodeUnsignedPinManifest(unsigned));
    expect(encoded.includes("prev_manifest")).toBe(false);
  });

  it("includes prev_manifest when provided", async () => {
    const genesisCid = await testCid(0, null, "with-prev");
    const prevManifestCid = await testCid(0, null, "prev-manifest");
    const unsigned = buildUnsignedPinManifest({
      headCid: genesisCid,
      genesisCid,
      recordCids: [genesisCid],
      seq: 0,
      generatedAt: "2026-07-28T00:00:00Z",
      prevManifestCid
    });

    expect(unsigned.prev_manifest).toBe(prevManifestCid);
  });

  it("round-trips encode and decode", async () => {
    const soul = generateKeypair();
    const genesisCid = await testCid(0, null, "roundtrip-a");
    const headCid = await testCid(1, genesisCid, "roundtrip-b");

    const signed = signPinManifest(
      buildUnsignedPinManifest({
        headCid,
        genesisCid,
        recordCids: [genesisCid, headCid],
        seq: 1,
        generatedAt: "2026-07-28T00:00:00Z"
      }),
      soul.privateKey
    );

    const bytes = encodePinManifest(signed);
    const decoded = decodePinManifest(bytes);
    expect(decoded).toEqual(signed);
    expect(encodePinManifest(decoded)).toEqual(bytes);
  });

  it("rejects tampered manifest signatures", async () => {
    const soul = generateKeypair();
    const genesisCid = await testCid(0, null, "tamper");

    const signed = signPinManifest(
      buildUnsignedPinManifest({
        headCid: genesisCid,
        genesisCid,
        recordCids: [genesisCid],
        seq: 0,
        generatedAt: "2026-07-28T00:00:00Z"
      }),
      soul.privateKey
    );

    // Keep valid base64url/length so decode succeeds; flip one signature byte.
    const sigBytes = decodeSignature(signed.sig);
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
    const tampered = {
      ...signed,
      sig: encodeSignature(sigBytes)
    };

    await expect(verifyPinManifest(tampered, soul.publicKey)).rejects.toThrow(VerificationError);
  });
});
