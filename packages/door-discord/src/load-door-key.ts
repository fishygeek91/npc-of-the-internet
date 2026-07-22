import { readFileSync } from "node:fs";

import { decodeBase64Url, type Ed25519Keypair } from "@npc/osp-core";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import { DiscordDoorError } from "./errors.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

const DOOR_PRIVATE_KEY_LENGTH = 32;

/**
 * Parse a door private key file as either raw 32 bytes or base64url-encoded 32 bytes.
 * Error messages name the path and format problem only — never key material.
 */
function parseDoorPrivateKeyBytes(fileBytes: Buffer, path: string): Uint8Array {
  if (fileBytes.length === DOOR_PRIVATE_KEY_LENGTH) {
    return new Uint8Array(fileBytes);
  }

  const trimmed = fileBytes.toString("utf8").trim();
  if (trimmed.length === 0) {
    throw new DiscordDoorError("invalid_config", `door key file at ${path} is empty`);
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(trimmed);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid base64url encoding";
    throw new DiscordDoorError(
      "invalid_config",
      `door key file at ${path} must be ${String(DOOR_PRIVATE_KEY_LENGTH)} raw bytes or base64url: ${detail}`
    );
  }

  if (decoded.length !== DOOR_PRIVATE_KEY_LENGTH) {
    throw new DiscordDoorError(
      "invalid_config",
      `door key file at ${path} must decode to ${String(DOOR_PRIVATE_KEY_LENGTH)} bytes, got ${String(decoded.length)}`
    );
  }

  return decoded;
}

/**
 * Load a door Ed25519 keypair from a private-key file path.
 */
export function loadDoorKeypairFromPath(path: string): Ed25519Keypair {
  let fileBytes: Buffer;
  try {
    fileBytes = readFileSync(path);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new DiscordDoorError(
      "invalid_config",
      `failed to read door key file at ${path}: ${detail}`
    );
  }

  const privateKey = parseDoorPrivateKeyBytes(fileBytes, path);
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}
