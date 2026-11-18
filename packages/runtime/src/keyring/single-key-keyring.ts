import { publicKeyFromPrivate, sign } from "@npc/osp-core";

import { deriveSessionKeyMaterial } from "./derive-session-key.js";
import { KeyringError } from "./errors.js";
import type { Keyring, SessionSigner } from "./types.js";

const SOUL_PRIVATE_KEY_LENGTH = 32;

/**
 * v0.1 Keyring backed by a single injected 32-byte soul private key.
 */
export class SingleKeyKeyring implements Keyring {
  private readonly soulPrivateKey: Uint8Array;
  private readonly soulPublicKey: Uint8Array;

  constructor(soulPrivateKey: Uint8Array) {
    if (soulPrivateKey.length !== SOUL_PRIVATE_KEY_LENGTH) {
      throw new KeyringError(
        `soul private key must be ${String(SOUL_PRIVATE_KEY_LENGTH)} bytes, got ${String(soulPrivateKey.length)}`
      );
    }
    this.soulPrivateKey = soulPrivateKey;
    this.soulPublicKey = publicKeyFromPrivate(soulPrivateKey);
  }

  signWithSoulKey(payload: Uint8Array): Uint8Array {
    return sign(payload, this.soulPrivateKey);
  }

  deriveSessionKey(doorId: string, epoch: number): SessionSigner {
    const { privateKey, publicKey } = deriveSessionKeyMaterial(this.soulPrivateKey, doorId, epoch);
    return {
      publicKey,
      sign(payload: Uint8Array): Uint8Array {
        return sign(payload, privateKey);
      }
    };
  }

  getSoulPublicKey(): Uint8Array {
    return this.soulPublicKey;
  }
}
