import { describe, expect, it } from "vitest";

import { decodeBase64Url, encodeBase64Url } from "../src/encoding/base64url.js";
import { parsePrivateKeyBytes, PrivateKeyParseError } from "../src/encoding/private-key.js";
import { EncodingError } from "../src/errors.js";

/** TEST-ONLY: deterministic 32-byte fill (not a real secret). */
const RAW_KEY = new Uint8Array(32).fill(0x11);

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function expectParseError(bytes: Uint8Array): PrivateKeyParseError {
  try {
    parsePrivateKeyBytes(bytes);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PrivateKeyParseError);
    expect(error).toBeInstanceOf(EncodingError);
    if (error instanceof PrivateKeyParseError) {
      expect(error.code).toBe("ENCODING_ERROR");
      return error;
    }
  }
  throw new Error("expected PrivateKeyParseError");
}

describe("parsePrivateKeyBytes", () => {
  it("accepts raw 32 bytes and returns a copy", () => {
    const parsed = parsePrivateKeyBytes(RAW_KEY);
    expect(parsed).toEqual(RAW_KEY);
    expect(parsed).not.toBe(RAW_KEY);

    const mutable = new Uint8Array(RAW_KEY);
    const copied = parsePrivateKeyBytes(mutable);
    mutable[0] = 0;
    expect(copied[0]).toBe(0x11);
  });

  it("treats a 32-byte ASCII buffer as raw, not base64url", () => {
    const ascii = textBytes("A".repeat(32));
    expect(ascii.length).toBe(32);
    const parsed = parsePrivateKeyBytes(ascii);
    expect(parsed).toEqual(ascii);
    expect(parsed).not.toEqual(decodeBase64Url("A".repeat(32)));
  });

  it("accepts base64url text with and without a trailing newline", () => {
    const encoded = encodeBase64Url(RAW_KEY);
    expect(parsePrivateKeyBytes(textBytes(encoded))).toEqual(RAW_KEY);
    expect(parsePrivateKeyBytes(textBytes(`${encoded}\n`))).toEqual(RAW_KEY);
    expect(parsePrivateKeyBytes(textBytes(`\n${encoded}\r\n`))).toEqual(RAW_KEY);
    expect(parsePrivateKeyBytes(textBytes(`  ${encoded}  `))).toEqual(RAW_KEY);
  });

  it("rejects raw buffers that are not 32 bytes and not base64url for 32 bytes", () => {
    for (const length of [16, 31, 33]) {
      const error = expectParseError(new Uint8Array(length).fill(0xff));
      expect(error.failure.kind).toBe("invalid_encoding");
      expect(error.message).not.toContain("ff");
    }
  });

  it("rejects base64url text that decodes to the wrong length", () => {
    for (const length of [16, 31, 33]) {
      const encoded = encodeBase64Url(new Uint8Array(length).fill(0xab));
      const error = expectParseError(textBytes(encoded));
      expect(error.failure).toEqual({ kind: "bad_length", decodedLength: length });
      expect(error.message).toBe(`private key must decode to 32 bytes, got ${String(length)}`);
      expect(error.message).not.toContain(encoded);
    }
  });

  it("rejects invalid base64url without echoing the input", () => {
    const input = "not-a-key!!";
    const error = expectParseError(textBytes(input));
    expect(error.failure).toEqual({
      kind: "invalid_encoding",
      detail: "base64url: invalid alphabet"
    });
    expect(error.message).toBe(
      "private key must be 32 raw bytes or base64url: base64url: invalid alphabet"
    );
    expect(error.message).not.toContain(input);

    const padded = expectParseError(textBytes("AAAA="));
    expect(padded.failure.kind).toBe("invalid_encoding");
    expect(padded.message).not.toContain("AAAA");
  });

  it("rejects empty and whitespace-only input", () => {
    const empty = expectParseError(new Uint8Array());
    expect(empty.failure).toEqual({ kind: "empty" });
    expect(empty.message).toBe("private key is empty");

    const whitespace = expectParseError(textBytes(" \n\t"));
    expect(whitespace.failure).toEqual({ kind: "empty" });
  });
});
