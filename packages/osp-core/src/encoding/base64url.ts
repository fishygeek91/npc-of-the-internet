import { EncodingError } from "../errors.js";

const BASE64URL_ALPHABET_RE = /^[A-Za-z0-9_-]+$/;
const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

/**
 * Encode raw bytes as unpadded base64url.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 6) {
      bits -= 6;
      const index = (buffer >> bits) & 0x3f;
      result += BASE64URL_CHARS.charAt(index);
    }
  }

  if (bits > 0) {
    const index = (buffer << (6 - bits)) & 0x3f;
    result += BASE64URL_CHARS.charAt(index);
  }

  return result;
}

/**
 * Decode a base64url string to raw bytes.
 * Rejects padding, standard base64 alphabet chars, and invalid characters.
 */
export function decodeBase64Url(encoded: string): Uint8Array {
  if (encoded.length === 0) {
    throw new EncodingError("base64url: empty input");
  }
  if (encoded.length % 4 === 1) {
    throw new EncodingError("base64url: invalid length");
  }
  if (!BASE64URL_ALPHABET_RE.test(encoded)) {
    throw new EncodingError("base64url: invalid alphabet");
  }

  const output: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of encoded) {
    const index = BASE64URL_CHARS.indexOf(char);
    if (index === -1) {
      throw new EncodingError("base64url: invalid alphabet");
    }

    buffer = (buffer << 6) | index;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }

  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new EncodingError("base64url: non-zero trailing bits");
  }

  return new Uint8Array(output);
}

/**
 * Encode a 32-byte Ed25519 public key as base64url.
 */
export function encodePublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) {
    throw new EncodingError(
      `public key must be exactly ${PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`
    );
  }
  return encodeBase64Url(publicKey);
}

/**
 * Decode a base64url public key; must be exactly 32 raw bytes.
 */
export function decodePublicKey(encoded: string): Uint8Array {
  const bytes = decodeBase64Url(encoded);
  if (bytes.length !== PUBLIC_KEY_LENGTH) {
    throw new EncodingError(
      `public key must decode to exactly ${PUBLIC_KEY_LENGTH} bytes, got ${bytes.length}`
    );
  }
  return bytes;
}

/**
 * Encode a 64-byte Ed25519 signature as base64url.
 */
export function encodeSignature(signature: Uint8Array): string {
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new EncodingError(
      `signature must be exactly ${SIGNATURE_LENGTH} bytes, got ${signature.length}`
    );
  }
  return encodeBase64Url(signature);
}

/**
 * Decode a base64url signature; must be exactly 64 raw bytes.
 */
export function decodeSignature(encoded: string): Uint8Array {
  const bytes = decodeBase64Url(encoded);
  if (bytes.length !== SIGNATURE_LENGTH) {
    throw new EncodingError(
      `signature must decode to exactly ${SIGNATURE_LENGTH} bytes, got ${bytes.length}`
    );
  }
  return bytes;
}
