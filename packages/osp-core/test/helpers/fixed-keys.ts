import { publicKeyFromPrivate, type Ed25519Keypair } from "../../src/crypto/ed25519.js";

/**
 * TEST-ONLY deterministic Ed25519 keypair.
 *
 * The private key is 32 bytes filled with `fillByte`. Fill bytes 7–11 match
 * `scripts/generate-vectors.ts`. Never use these keys in production.
 *
 * @throws {Error} when `fillByte` is not an integer in 0..255.
 */
export function fixedKeypair(fillByte: number): Ed25519Keypair {
  if (!Number.isInteger(fillByte) || fillByte < 0 || fillByte > 255) {
    throw new Error(`fixedKeypair fillByte must be an integer 0..255, got ${String(fillByte)}`);
  }
  const privateKey = new Uint8Array(32).fill(fillByte);
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}

/** TEST-ONLY soul key (fill 7). */
export const SOUL = fixedKeypair(7);
/** TEST-ONLY door key (fill 8). */
export const DOOR = fixedKeypair(8);
/** TEST-ONLY session key (fill 9). */
export const SESSION = fixedKeypair(9);
/** TEST-ONLY alternate door key (fill 10). */
export const OTHER_DOOR = fixedKeypair(10);
/** TEST-ONLY alternate session key (fill 11). */
export const OTHER_SESSION = fixedKeypair(11);
/** TEST-ONLY extra door key (fill 12), distinct from the vector keys. */
export const EXTRA_DOOR = fixedKeypair(12);
