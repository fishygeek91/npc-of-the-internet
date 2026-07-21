import { readFileSync } from "node:fs";

import { decodeBase64Url } from "@npc/osp-core";

import { KeyringError } from "./errors.js";

const SOUL_PRIVATE_KEY_LENGTH = 32;

/**
 * Parse a soul private key file as either raw 32 bytes or base64url-encoded 32 bytes.
 */
function parseSoulPrivateKeyBytes(fileBytes: Buffer, path: string): Uint8Array {
  if (fileBytes.length === SOUL_PRIVATE_KEY_LENGTH) {
    return new Uint8Array(fileBytes);
  }

  const trimmed = fileBytes.toString("utf8").trim();
  if (trimmed.length === 0) {
    throw new KeyringError(`soul key file at ${path} is empty`);
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(trimmed);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid base64url encoding";
    throw new KeyringError(
      `soul key file at ${path} must be ${String(SOUL_PRIVATE_KEY_LENGTH)} raw bytes or base64url: ${detail}`
    );
  }

  if (decoded.length !== SOUL_PRIVATE_KEY_LENGTH) {
    throw new KeyringError(
      `soul key file at ${path} must decode to ${String(SOUL_PRIVATE_KEY_LENGTH)} bytes, got ${String(decoded.length)}`
    );
  }

  return decoded;
}

/**
 * Load a 32-byte soul private key from disk (raw bytes or base64url text).
 * Error messages name the path and format problem only — never key material.
 */
export function loadSoulPrivateKeyFromPath(path: string): Uint8Array {
  let fileBytes: Buffer;
  try {
    fileBytes = readFileSync(path);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new KeyringError(`failed to read soul key file at ${path}: ${detail}`);
  }

  return parseSoulPrivateKeyBytes(fileBytes, path);
}
