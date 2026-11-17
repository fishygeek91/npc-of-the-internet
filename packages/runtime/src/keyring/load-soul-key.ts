import { readFileSync } from "node:fs";

import { parsePrivateKeyBytes, PrivateKeyParseError } from "@npc/osp-core";

import { KeyringError } from "./errors.js";

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
 * Map a shared parse failure onto this loader's messages. The path stays here;
 * the parser never sees it and never includes key bytes.
 */
function soulKeyParseMessage(path: string, error: PrivateKeyParseError): string {
  const failure = error.failure;
  switch (failure.kind) {
    case "empty":
      return `soul key file at ${path} is empty`;
    case "invalid_encoding":
      return `soul key file at ${path} must be 32 raw bytes or base64url: ${failure.detail}`;
    case "bad_length":
      return (
        `soul key file at ${path} must decode to 32 bytes, got ` + String(failure.decodedLength)
      );
  }
}

/**
 * Parse a soul private key file as either raw 32 bytes or base64url-encoded 32 bytes.
 */
function parseSoulPrivateKeyBytes(fileBytes: Uint8Array, path: string): Uint8Array {
  try {
    return parsePrivateKeyBytes(fileBytes);
  } catch (error: unknown) {
    if (error instanceof PrivateKeyParseError) {
      throw new KeyringError(soulKeyParseMessage(path, error));
    }
    throw error;
  }
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
