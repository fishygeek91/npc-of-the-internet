import { z } from "zod";

import { EncodingError } from "../errors.js";

const BASE64URL_ALPHABET_RE = /^[A-Za-z0-9_-]+$/;
const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

/**
 * Type-only brand carrier. Not a validator — {@link asBase64Url} is.
 * Kept private so callers do not parse through a schema that accepts any string.
 */
const base64UrlBrandSchema = z.string().brand<"Base64Url">();

/**
 * Unpadded base64url text, including the empty encoding of zero bytes.
 *
 * Zod output brand (`brand<"Base64Url">`, direction `"out"`). The brand is
 * type-only. {@link encodeBase64Url} produces it; {@link asBase64Url} checks it.
 * {@link decodeBase64Url} is stricter: it rejects empty input, length `4k+1`,
 * and non-zero trailing bits. A {@link Base64Url} is assignable to `string`.
 */
export type Base64Url = z.output<typeof base64UrlBrandSchema>;

/**
 * True when `value` is empty or {@link decodeBase64Url} accepts it.
 * Narrows to {@link Base64Url}.
 */
export function isBase64Url(value: string): value is Base64Url {
  if (value.length === 0) {
    return true;
  }
  try {
    decodeBase64Url(value);
    return true;
  } catch (error: unknown) {
    if (error instanceof EncodingError) {
      return false;
    }
    throw error;
  }
}

/**
 * Require unpadded base64url.
 * Empty string is the encoding of zero bytes (the decoder rejects it).
 *
 * @throws {EncodingError} when `value` is not unpadded base64url.
 */
export function asBase64Url(value: string): Base64Url {
  if (value.length !== 0) {
    decodeBase64Url(value);
  }
  if (!isBase64Url(value)) {
    throw new EncodingError("base64url: invalid encoding");
  }
  return base64UrlBrandSchema.parse(value);
}

/**
 * Encode raw bytes as unpadded base64url.
 * Output is {@link Base64Url} by construction of this encoder.
 */
export function encodeBase64Url(bytes: Uint8Array): Base64Url {
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

  return asBase64Url(result);
}

/**
 * Decode a base64url string to raw bytes.
 * Rejects padding, standard base64 alphabet chars, and invalid characters.
 * Rejects the empty string; use {@link asBase64Url} when the empty encoding is allowed.
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
 * Wire encoding of a 32-byte Ed25519 public key (soul, session, or Door).
 *
 * Same brand for every 32-byte key: the type distinguishes keys from CIDs and
 * signatures, not soul keys from Door keys. Raw key bytes stay `Uint8Array`
 * ({@link decodePublicKey}, `verify`). Zod brand direction is `"out"`, so
 * schema input is still `string`.
 */
export type SoulPublicKey = z.output<typeof SoulPublicKeySchema>;

/**
 * Zod schema for a base64url-encoded 32-byte Ed25519 public key.
 * `.brand()` does not change validation or JSON Schema.
 */
export const SoulPublicKeySchema = z
  .string()
  .superRefine((value, ctx) => {
    try {
      decodePublicKey(value);
    } catch (error: unknown) {
      if (error instanceof EncodingError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error.message
        });
        return;
      }
      throw error;
    }
  })
  .brand<"SoulPublicKey">();

/**
 * True when {@link decodePublicKey} accepts `value`. Narrows to {@link SoulPublicKey}.
 */
export function isSoulPublicKey(value: string): value is SoulPublicKey {
  const parsed = SoulPublicKeySchema.safeParse(value);
  return parsed.success;
}

/**
 * Require a 32-byte Ed25519 public key on the wire.
 *
 * @throws {EncodingError} when `value` is not that encoding.
 */
export function asSoulPublicKey(value: string): SoulPublicKey {
  const parsed = SoulPublicKeySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EncodingError(issue === undefined ? "invalid public key" : issue.message);
  }
  return parsed.data;
}

/**
 * Encode a 32-byte Ed25519 public key as base64url.
 *
 * @throws {EncodingError} when `publicKey` is not 32 bytes.
 */
export function encodePublicKey(publicKey: Uint8Array): SoulPublicKey {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) {
    throw new EncodingError(
      `public key must be exactly ${PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`
    );
  }
  return asSoulPublicKey(encodeBase64Url(publicKey));
}

/**
 * Decode a base64url public key; must be exactly 32 raw bytes.
 * Accepts a plain `string` or a {@link SoulPublicKey}. Returns raw bytes.
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
 * Wire encoding of a 64-byte Ed25519 signature.
 * Zod output brand. Raw signature bytes stay `Uint8Array` ({@link decodeSignature}, `verify`).
 */
export type Ed25519Signature = z.output<typeof Ed25519SignatureSchema>;

/**
 * Zod schema for a base64url-encoded 64-byte Ed25519 signature.
 * `.brand()` does not change validation or JSON Schema.
 */
export const Ed25519SignatureSchema = z
  .string()
  .superRefine((value, ctx) => {
    try {
      decodeSignature(value);
    } catch (error: unknown) {
      if (error instanceof EncodingError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error.message
        });
        return;
      }
      throw error;
    }
  })
  .brand<"Ed25519Signature">();

/**
 * True when {@link decodeSignature} accepts `value`. Narrows to {@link Ed25519Signature}.
 */
export function isEd25519Signature(value: string): value is Ed25519Signature {
  const parsed = Ed25519SignatureSchema.safeParse(value);
  return parsed.success;
}

/**
 * Require a 64-byte Ed25519 signature on the wire.
 *
 * @throws {EncodingError} when `value` is not that encoding.
 */
export function asEd25519Signature(value: string): Ed25519Signature {
  const parsed = Ed25519SignatureSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EncodingError(issue === undefined ? "invalid signature" : issue.message);
  }
  return parsed.data;
}

/**
 * Encode a 64-byte Ed25519 signature as base64url.
 *
 * @throws {EncodingError} when `signature` is not 64 bytes.
 */
export function encodeSignature(signature: Uint8Array): Ed25519Signature {
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new EncodingError(
      `signature must be exactly ${SIGNATURE_LENGTH} bytes, got ${signature.length}`
    );
  }
  return asEd25519Signature(encodeBase64Url(signature));
}

/**
 * Decode a base64url signature; must be exactly 64 raw bytes.
 * Accepts a plain `string` or an {@link Ed25519Signature}. Returns raw bytes.
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
