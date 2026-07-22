/**
 * TEST-ONLY deterministic Ed25519 keys and fixture constants for Atlas tests.
 * Private keys are fill-byte patterns (see `packages/osp-core/scripts/generate-vectors.ts`).
 */
import { decodeBase64Url, decodePublicKey, type Ed25519Keypair } from "@npc/osp-core";

function testKeypair(privateKeyB64: string, publicKeyB64: string): Ed25519Keypair {
  return {
    privateKey: decodeBase64Url(privateKeyB64),
    publicKey: decodePublicKey(publicKeyB64)
  };
}

/** TEST-ONLY soul key (fill 7). */
export const SOUL = testKeypair(
  "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw"
);
/** TEST-ONLY door key for residency 1 (fill 8). */
export const DOOR = testKeypair(
  "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
  "E5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8o"
);
/** TEST-ONLY session key (fill 9). */
export const SESSION = testKeypair(
  "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
  "_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg"
);
/** TEST-ONLY door key for residency 2 (fill 10). */
export const OTHER_DOOR = testKeypair(
  "CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo",
  "Q6cucUQBdi32a2jCbfvfJoKq7J8kdOykYT5CSg-6_Tw"
);

export const DOOR_ID = "discord:g";
export const OTHER_DOOR_ID = "irc:libera-wanderer";
export const RESIDENCY_1 = "door:discord:g/epoch:1";
export const RESIDENCY_2 = "door:irc:libera-wanderer/epoch:2";

export const JOURNAL_EPOCH_1 = "JOURNAL_EPOCH_1";
export const JOURNAL_EPOCH_2 = "JOURNAL_EPOCH_2";
export const LEAK_SHARD_TEXT = "LEAK_SHARD_TEXT_DO_NOT_APPEAR_IN_RECORDS";

export const DOOR_PUBLIC_KEY_B64 = "E5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8o";
export const OTHER_DOOR_PUBLIC_KEY_B64 = "Q6cucUQBdi32a2jCbfvfJoKq7J8kdOykYT5CSg-6_Tw";
