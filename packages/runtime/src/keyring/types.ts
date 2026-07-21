/**
 * Ephemeral session signer for one `(door_id, epoch)` residency.
 * Callers receive only the public key and a sign function — never the derived private key.
 */
export interface SessionSigner {
  readonly publicKey: Uint8Array;
  sign(payload: Uint8Array): Uint8Array;
}

/**
 * Abstract custody boundary for soul and session signing.
 * All runtime signing MUST go through this interface (PoP spec §3.2).
 */
export interface Keyring {
  signWithSoulKey(payload: Uint8Array): Uint8Array;
  deriveSessionKey(doorId: string, epoch: number): SessionSigner;
  getSoulPublicKey(): Uint8Array;
}
