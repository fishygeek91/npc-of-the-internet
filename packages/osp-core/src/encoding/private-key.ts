import { EncodingError } from "../errors.js";
import { decodeBase64Url } from "./base64url.js";

/** Ed25519 private keys are a 32-byte seed (RFC 8032). */
const PRIVATE_KEY_LENGTH = 32;

/**
 * Why {@link parsePrivateKeyBytes} rejected a buffer.
 * Values name the format problem only — never key bytes, never a filesystem path.
 */
export type PrivateKeyParseFailure =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid_encoding"; readonly detail: string }
  | { readonly kind: "bad_length"; readonly decodedLength: number };

/**
 * Private-key file bytes were neither 32 raw bytes nor base64url text for 32 bytes.
 * Subclass of {@link EncodingError} so existing `instanceof EncodingError` checks still match.
 */
export class PrivateKeyParseError extends EncodingError {
  readonly failure: PrivateKeyParseFailure;

  constructor(failure: PrivateKeyParseFailure) {
    super(describePrivateKeyParseFailure(failure));
    this.failure = failure;
  }
}

/**
 * Stable, key-free message for a parse failure. Callers that own a path map
 * {@link PrivateKeyParseError.failure} onto their own wording instead of this string.
 */
function describePrivateKeyParseFailure(failure: PrivateKeyParseFailure): string {
  switch (failure.kind) {
    case "empty":
      return "private key is empty";
    case "invalid_encoding":
      return (
        `private key must be ${String(PRIVATE_KEY_LENGTH)} raw bytes or base64url: ` +
        failure.detail
      );
    case "bad_length":
      return (
        `private key must decode to ${String(PRIVATE_KEY_LENGTH)} bytes, got ` +
        String(failure.decodedLength)
      );
  }
}

/**
 * Parse private-key file bytes.
 *
 * Shared rule of the soul and Door loaders: a buffer of exactly 32 bytes is raw key
 * material (even when those bytes are printable). Any other length is UTF-8 text with
 * leading and trailing whitespace removed, including a trailing newline, then unpadded
 * base64url that must decode to exactly 32 bytes.
 *
 * Browser-safe: no `node:fs`. Text is decoded with `TextDecoder` (invalid UTF-8 becomes
 * U+FFFD, matching the loaders' `Buffer.toString("utf8")` for the base64url alphabet).
 *
 * @throws {PrivateKeyParseError} when the bytes match neither form.
 */
export function parsePrivateKeyBytes(bytes: Uint8Array): Uint8Array {
  // Length 32 is always the raw form. Do not try base64url on it.
  if (bytes.length === PRIVATE_KEY_LENGTH) {
    return new Uint8Array(bytes);
  }

  const trimmed = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  if (trimmed.length === 0) {
    throw new PrivateKeyParseError({ kind: "empty" });
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(trimmed);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid base64url encoding";
    throw new PrivateKeyParseError({ kind: "invalid_encoding", detail });
  }

  if (decoded.length !== PRIVATE_KEY_LENGTH) {
    throw new PrivateKeyParseError({
      kind: "bad_length",
      decodedLength: decoded.length
    });
  }

  return decoded;
}
