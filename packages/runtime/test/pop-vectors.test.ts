import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePublicKey, decodeSignature, encodePublicKey, sign, verify } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { deriveSessionKeyMaterial } from "../src/keyring/derive-session-key.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const vectorPath = resolve(testDir, "../../../spec/pop/vectors/session-key-derivation.json");

type RawVectorCase = {
  description: string;
  soulPrivateKeyFillByte?: number;
  soulPrivateKeyHex?: string;
  soulPrivateKeyBase64Url?: string;
  doorId: string;
  epoch: number;
  expectedSessionPublicKey: string;
  samplePayload: string;
  expectedSignature: string;
};

type VectorFile = {
  description: string;
  algorithm: string;
  cases: RawVectorCase[];
};

function soulPrivateKeyFromCase(vectorCase: RawVectorCase): Uint8Array {
  if (vectorCase.soulPrivateKeyFillByte !== undefined) {
    return new Uint8Array(32).fill(vectorCase.soulPrivateKeyFillByte);
  }
  if (vectorCase.soulPrivateKeyHex !== undefined) {
    const hex = vectorCase.soulPrivateKeyHex;
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      const slice = hex.slice(index * 2, index * 2 + 2);
      bytes[index] = Number.parseInt(slice, 16);
    }
    return bytes;
  }
  if (vectorCase.soulPrivateKeyBase64Url !== undefined) {
    throw new Error("soulPrivateKeyBase64Url is not supported in tests yet");
  }
  throw new Error(`vector case missing soul private key material: ${vectorCase.description}`);
}

function loadVectorFile(): VectorFile {
  const raw = readFileSync(vectorPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("session-key-derivation.json root must be an object");
  }

  const description = Reflect.get(parsed, "description");
  const algorithm = Reflect.get(parsed, "algorithm");
  const cases = Reflect.get(parsed, "cases");

  if (typeof description !== "string" || description.length === 0) {
    throw new Error("session-key-derivation.json: description must be a non-empty string");
  }
  if (typeof algorithm !== "string" || algorithm.length === 0) {
    throw new Error("session-key-derivation.json: algorithm must be a non-empty string");
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("session-key-derivation.json: cases must be a non-empty array");
  }

  return { description, algorithm, cases: cases as RawVectorCase[] };
}

describe("PoP session-key derivation vectors", () => {
  const vector = loadVectorFile();

  it("loads committed vector metadata", () => {
    expect(vector.description.length).toBeGreaterThan(0);
    expect(vector.algorithm).toContain("HKDF-SHA-512");
    expect(vector.cases.length).toBeGreaterThanOrEqual(3);
  });

  it.each(
    vector.cases.map((vectorCase, index) => [vectorCase.description, index, vectorCase] as const)
  )("%s", (_label, _index, vectorCase) => {
    const soulPrivateKey = soulPrivateKeyFromCase(vectorCase);
    const { privateKey, publicKey } = deriveSessionKeyMaterial(
      soulPrivateKey,
      vectorCase.doorId,
      vectorCase.epoch
    );

    expect(encodePublicKey(publicKey)).toBe(vectorCase.expectedSessionPublicKey);

    const payloadBytes = new TextEncoder().encode(vectorCase.samplePayload);
    const signature = sign(payloadBytes, privateKey);
    expect(signature).toEqual(decodeSignature(vectorCase.expectedSignature));

    const expectedPublicKey = decodePublicKey(vectorCase.expectedSessionPublicKey);
    expect(verify(payloadBytes, signature, expectedPublicKey)).toBe(true);
  });
});
