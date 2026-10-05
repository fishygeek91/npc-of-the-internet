import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

import { EncodingError, FileSoulStore, parseDoorPublicKeyMap, StorageError } from "@npc/osp-core";

import { writeStderr } from "../io.js";

/** Exit code for usage errors and I/O failures. */
export const EXIT_USAGE = 2;

/** Result of {@link openReadOnlyStore}: an open store, or the exit code to return. */
export type ReadOnlyStoreResult = { store: FileSoulStore } | { exitCode: number };

/**
 * Open an existing soulchain directory read-only for inspection commands (`log`, `show`).
 *
 * Never creates directories or files (a typo'd path must not leave an empty chain behind).
 * `doorKeys` are `doorId=base64url` bindings (repeatable `--door-key`, same convention as
 * `osp verify`) so cosigned records verify. Writes the reason to stderr and returns
 * {@link EXIT_USAGE} for a missing directory, missing layout, or malformed `--door-key`.
 */
export async function openReadOnlyStore(
  dir: string,
  doorKeys: readonly string[] = []
): Promise<ReadOnlyStoreResult> {
  const resolvedDir = path.resolve(dir);
  let isDirectory = false;
  try {
    isDirectory = existsSync(resolvedDir) && statSync(resolvedDir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    writeStderr(`Soulchain directory not found: ${resolvedDir}`);
    return { exitCode: EXIT_USAGE };
  }

  let doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined;
  if (doorKeys.length > 0) {
    try {
      doorPublicKeys = parseDoorPublicKeyMap(doorKeys);
    } catch (error) {
      if (error instanceof EncodingError) {
        writeStderr(error.message);
        return { exitCode: EXIT_USAGE };
      }
      throw error;
    }
  }

  try {
    const store = await FileSoulStore.openReadOnly(
      resolvedDir,
      doorPublicKeys === undefined ? undefined : { doorPublicKeys }
    );
    return { store };
  } catch (error) {
    if (error instanceof StorageError) {
      writeStderr(error.message);
      return { exitCode: EXIT_USAGE };
    }
    throw error;
  }
}
