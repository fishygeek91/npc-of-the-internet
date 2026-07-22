import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { Ed25519Keypair } from "@npc/osp-core";

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

/**
 * TEST-ONLY: deterministic Ed25519 keypair from a fixed 32-byte private key fill pattern.
 */
function testKeypair(fillByte: number): Ed25519Keypair {
  const privateKey = new Uint8Array(32).fill(fillByte);
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** TEST-ONLY soul key (fill 7). */
export const SOUL = testKeypair(7);

/** TEST-ONLY door key (fill 8). */
export const DOOR = testKeypair(8);
