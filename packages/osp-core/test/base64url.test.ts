import { describe, expect, it } from "vitest";

import { EncodingError } from "../src/errors.js";
import {
  decodeBase64Url,
  decodePublicKey,
  decodeSignature,
  encodeBase64Url,
  encodePublicKey,
  encodeSignature
} from "../src/encoding/base64url.js";
import { generateKeypair, sign } from "../src/crypto/ed25519.js";

describe("base64url", () => {
  it("roundtrips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 63]);
    const encoded = encodeBase64Url(bytes);
    expect(decodeBase64Url(encoded)).toEqual(bytes);
  });

  it("rejects padding and standard base64 alphabet characters", () => {
    expect(() => decodeBase64Url("abcd==")).toThrow(EncodingError);
    expect(() => decodeBase64Url("ab+cd")).toThrow(EncodingError);
    expect(() => decodeBase64Url("ab/cd")).toThrow(EncodingError);
    expect(() => decodeBase64Url("")).toThrow(EncodingError);
  });

  it("rejects length congruent to 1 mod 4", () => {
    expect(() => decodeBase64Url("A")).toThrow(EncodingError);
    expect(() => decodeBase64Url("ABCDE")).toThrow(EncodingError);
  });

  it("rejects non-zero trailing bits", () => {
    // One zero byte encodes as "AA". "AB"/"AC" decode to the same byte under
    // permissive base64 but have non-zero pad bits — reject them.
    expect(decodeBase64Url("AA")).toEqual(new Uint8Array([0]));
    expect(() => decodeBase64Url("AB")).toThrow(EncodingError);
    expect(() => decodeBase64Url("AC")).toThrow(EncodingError);
  });

  it("encodes and decodes public keys at exactly 32 bytes", () => {
    const { publicKey } = generateKeypair();
    const encoded = encodePublicKey(publicKey);
    expect(decodePublicKey(encoded)).toEqual(publicKey);
    expect(() => encodePublicKey(new Uint8Array(31))).toThrow(EncodingError);
    expect(() => decodePublicKey(encodeBase64Url(new Uint8Array(31)))).toThrow(EncodingError);
  });

  it("encodes and decodes signatures at exactly 64 bytes", () => {
    const { privateKey, publicKey } = generateKeypair();
    const message = new TextEncoder().encode("osp test message");
    const signature = sign(message, privateKey);

    const encoded = encodeSignature(signature);
    expect(decodeSignature(encoded)).toEqual(signature);
    expect(() => encodeSignature(new Uint8Array(63))).toThrow(EncodingError);
    expect(() => decodeSignature(encodeBase64Url(new Uint8Array(63)))).toThrow(EncodingError);
    expect(publicKey.length).toBe(32);
    expect(signature.length).toBe(64);
  });
});
