import * as ed from "@noble/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha512 } from "@noble/hashes/sha512";

import { KeyringError } from "./errors.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

/** HKDF salt for PoP session-key derivation (`pop/0.1`). */
export const SESSION_KEY_DERIVATION_SALT = new TextEncoder().encode("npc-pop/0.1/session-key");

const SOUL_PRIVATE_KEY_LENGTH = 32;

/**
 * Build HKDF `info` for session-key derivation: UTF-8(door_id) || 0x00 || ASCII decimal epoch.
 */
export function buildSessionKeyInfo(doorId: string, epoch: number): Uint8Array {
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new KeyringError(`epoch must be an integer >= 1, got ${String(epoch)}`);
  }

  const doorBytes = new TextEncoder().encode(doorId);
  const epochBytes = new TextEncoder().encode(String(epoch));
  const info = new Uint8Array(doorBytes.length + 1 + epochBytes.length);
  info.set(doorBytes, 0);
  info[doorBytes.length] = 0;
  info.set(epochBytes, doorBytes.length + 1);
  return info;
}

/**
 * Derive a deterministic Ed25519 session keypair from soul material, door id, and epoch.
 * Algorithm: HKDF-SHA-512 (32-byte OKM) → Ed25519 seed → public key via `@noble/ed25519`.
 */
export function deriveSessionKeyMaterial(
  soulPrivateKey: Uint8Array,
  doorId: string,
  epoch: number
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  if (soulPrivateKey.length !== SOUL_PRIVATE_KEY_LENGTH) {
    throw new KeyringError(
      `soul private key must be ${String(SOUL_PRIVATE_KEY_LENGTH)} bytes, got ${String(soulPrivateKey.length)}`
    );
  }

  const info = buildSessionKeyInfo(doorId, epoch);
  const privateKey = hkdf(
    sha512,
    soulPrivateKey,
    SESSION_KEY_DERIVATION_SALT,
    info,
    SOUL_PRIVATE_KEY_LENGTH
  );
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}
