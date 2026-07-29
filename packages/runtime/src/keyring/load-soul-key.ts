import { readFileSync } from "node:fs";

import { decodeBase64Url } from "@npc/osp-core";

import { KeyringError } from "./errors.js";

const SOUL_PRIVATE_KEY_LENGTH = 32;

/** Container `npc` uid/gid pinned in ops Dockerfiles (#84). */
const NPC_CONTAINER_UID_GID = "10001";

function isNodeErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPermissionDenied(error: unknown): boolean {
  return isNodeErrno(error) && (error.code === "EACCES" || error.code === "EPERM");
}

function permissionDeniedMessage(keyPath: string): string {
  return (
    `cannot read soul key file at ${keyPath} (permissions): host file must be owned by ` +
    `uid/gid ${NPC_CONTAINER_UID_GID} (container user npc) with mode allowing the container ` +
    `to read it (typically 0600). See ops/RUNBOOK.ghost.md §5.`
  );
}

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
    if (isPermissionDenied(error)) {
      throw new KeyringError(permissionDeniedMessage(path));
    }
    const detail = error instanceof Error ? error.message : "read failed";
    throw new KeyringError(`failed to read soul key file at ${path}: ${detail}`);
  }

  return parseSoulPrivateKeyBytes(fileBytes, path);
}
