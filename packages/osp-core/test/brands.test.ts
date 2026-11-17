import { describe, expect, it } from "vitest";

import { asCid, computeCid, isValidCid, parseCid, type Cid } from "../src/crypto/cid.js";
import {
  asBase64Url,
  asEd25519Signature,
  asSoulPublicKey,
  encodeBase64Url,
  encodePublicKey,
  encodeSignature,
  type Base64Url,
  type Ed25519Signature,
  type SoulPublicKey
} from "../src/encoding/base64url.js";
import { EncodingError } from "../src/errors.js";
import {
  asResidency,
  makeResidency,
  parseResidency,
  type Residency
} from "../src/schemas/envelope.js";

/**
 * Compiled by `tsc -p tsconfig.types.json`. The assignment is rejected by the
 * type checker; the helper is not a runtime assertion.
 */
function plainStringAsCid(value: string): Cid {
  // @ts-expect-error plain string is not assignable to Cid
  return value;
}

/** @see plainStringAsCid */
function publicKeyAsCid(value: SoulPublicKey): Cid {
  // @ts-expect-error SoulPublicKey is not assignable to Cid
  return value;
}

/** @see plainStringAsCid */
function signatureAsPublicKey(value: Ed25519Signature): SoulPublicKey {
  // @ts-expect-error Ed25519Signature is not assignable to SoulPublicKey
  return value;
}

/** @see plainStringAsCid */
function base64UrlAsCid(value: Base64Url): Cid {
  // @ts-expect-error Base64Url is not assignable to Cid
  return value;
}

/** @see plainStringAsCid */
function plainStringAsResidency(value: string): Residency {
  // @ts-expect-error plain string is not assignable to Residency
  return value;
}

/** A brand is still a string. */
function cidAsString(value: Cid): string {
  return value;
}

describe("branded crypto vocabulary", () => {
  it("keeps the type-level exclusions in the compilation", () => {
    void plainStringAsCid;
    void publicKeyAsCid;
    void signatureAsPublicKey;
    void base64UrlAsCid;
    void plainStringAsResidency;
    void cidAsString;
  });

  it("rejects a plain string that is not a CID and accepts computeCid output", async () => {
    expect(parseCid("not-a-cid")).toBeNull();
    expect(() => asCid("not-a-cid")).toThrow(EncodingError);
    expect(isValidCid("not-a-cid")).toBe(false);

    const cid = await computeCid({ hello: "brand" });
    expect(asCid(cid)).toBe(cid);
    expect(parseCid(cid)).toBe(cid);
    expect(isValidCid(cid)).toBe(true);
  });

  it("rejects an invalid public key and accepts encodePublicKey output", () => {
    expect(() => asSoulPublicKey("too-short")).toThrow(EncodingError);
    const encoded = encodePublicKey(new Uint8Array(32).fill(7));
    expect(asSoulPublicKey(encoded)).toBe(encoded);
  });

  it("rejects an invalid signature and accepts encodeSignature output", () => {
    expect(() => asEd25519Signature("nope")).toThrow(EncodingError);
    const encoded = encodeSignature(new Uint8Array(64).fill(9));
    expect(asEd25519Signature(encoded)).toBe(encoded);
  });

  it("treats empty encoder output as base64url and rejects bad text", () => {
    expect(asBase64Url(encodeBase64Url(new Uint8Array()))).toBe("");
    const encoded = encodeBase64Url(new Uint8Array([1, 2, 3]));
    expect(asBase64Url(encoded)).toBe(encoded);
    expect(() => asBase64Url("@@@")).toThrow(EncodingError);
    expect(() => asBase64Url("A")).toThrow(EncodingError);
  });

  it("round-trips makeResidency with parseResidency", () => {
    const residency = makeResidency({ doorId: "discord:guild123", epoch: 7 });
    expect(residency).toBe("door:discord:guild123/epoch:7");
    const parsed = parseResidency(residency);
    expect(parsed).toEqual({ doorId: "discord:guild123", epoch: 7 });
    if (parsed === null) {
      throw new Error("parseResidency returned null");
    }
    expect(makeResidency(parsed)).toBe(residency);

    expect(makeResidency({ doorId: "web:home", epoch: 0 })).toBe("door:web:home/epoch:0");
    expect(asResidency("door:discord:g/epoch:1")).toBe("door:discord:g/epoch:1");
    expect(() => asResidency("door:guild/epoch:1")).toThrow(EncodingError);
    expect(() => makeResidency({ doorId: "Discord:g", epoch: 1 })).toThrow(EncodingError);
    expect(() => makeResidency({ doorId: "discord:g", epoch: 1.5 })).toThrow(EncodingError);
    expect(() => makeResidency({ doorId: "guild123", epoch: 1 })).toThrow(EncodingError);
  });
});
