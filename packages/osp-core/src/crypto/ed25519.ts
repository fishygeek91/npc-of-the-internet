import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

export interface Ed25519Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Generate a fresh Ed25519 keypair.
 */
export function generateKeypair(): Ed25519Keypair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Sign a message with an Ed25519 private key (64-byte signature).
 */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed.sign(message, privateKey);
}

/**
 * Verify an Ed25519 signature over a message.
 */
export function verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return ed.verify(signature, message, publicKey);
}
