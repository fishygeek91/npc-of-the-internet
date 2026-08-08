import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

import {
  CorruptionError,
  EncodingError,
  FileSoulStore,
  parseDoorPublicKeyMap,
  StorageError,
  type ChainFailure
} from "@npc/osp-core";

import { writeStderr, writeStdout } from "../io.js";

/** Exit code when chain verification fails. */
export const EXIT_VERIFY_FAILED = 1;

/** Exit code for usage errors and I/O failures. */
export const EXIT_USAGE = 2;

/** Options for {@link runVerify}. */
export type VerifyOptions = {
  dir: string;
  doorKeys?: readonly string[];
};

/** Print each chain verification failure to stdout. */
export function printFailures(failures: readonly ChainFailure[]): void {
  for (const failure of failures) {
    const cidPart = failure.cid === undefined ? "" : ` cid=${failure.cid}`;
    writeStdout(`[${failure.rule}] seq=${failure.seq}${cidPart}: ${failure.message}`);
  }
}

/** True when path exists and is a directory. */
function isExistingDirectory(resolvedDir: string): boolean {
  if (!existsSync(resolvedDir)) {
    return false;
  }
  try {
    return statSync(resolvedDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Open a soulchain directory read-only and report its verification result.
 * Returns exit code 0 when valid, 1 when verification fails, 2 on I/O or missing layout.
 *
 * Does not create `blobs/` or `chain.jsonl`. Torn tails surface as verification failures.
 */
export async function runVerify(options: VerifyOptions): Promise<number> {
  const resolvedDir = path.resolve(options.dir);
  if (!isExistingDirectory(resolvedDir)) {
    writeStderr(`Soulchain directory not found: ${resolvedDir}`);
    return EXIT_USAGE;
  }

  let doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined;
  if (options.doorKeys !== undefined && options.doorKeys.length > 0) {
    try {
      doorPublicKeys = parseDoorPublicKeyMap(options.doorKeys);
    } catch (error) {
      if (error instanceof EncodingError) {
        writeStderr(error.message);
        return EXIT_USAGE;
      }
      throw error;
    }
  }

  let store: FileSoulStore;
  try {
    const openOptions = doorPublicKeys === undefined ? undefined : { doorPublicKeys };
    store = await FileSoulStore.openReadOnly(options.dir, openOptions);
  } catch (error) {
    if (error instanceof StorageError) {
      writeStderr(error.message);
      return EXIT_USAGE;
    }
    if (error instanceof CorruptionError) {
      if (error.failures !== undefined && error.failures.length > 0) {
        printFailures(error.failures);
        return EXIT_VERIFY_FAILED;
      }
      writeStderr(`Chain store is corrupted: ${error.message}`);
      writeStderr(
        "If a crash left a torn append, recover with FileSoulStore.openWithRecovery before verifying again."
      );
      return EXIT_USAGE;
    }
    throw error;
  }

  try {
    const result = store.verification();

    if (result.valid) {
      return 0;
    }

    printFailures(result.failures);
    return EXIT_VERIFY_FAILED;
  } finally {
    await store.close();
  }
}
