import {
  CorruptionError,
  decodePublicKey,
  FileSoulStore,
  verifyChain,
  type ChainFailure,
  type ChainRule
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

/** Parse a verification failure embedded in a CorruptionError from FileSoulStore.open. */
export function parseVerificationCorruption(message: string): ChainFailure | null {
  const match = message.match(
    /^chain verification failed: ([a-z_]+) at seq (\d+)(?: \(cid ([^)]+)\))?: (.+)$/
  );
  if (match === null) {
    return null;
  }

  const rule = match[1];
  const seqText = match[2];
  const messageText = match[4];
  if (rule === undefined || seqText === undefined || messageText === undefined) {
    return null;
  }

  const failure: ChainFailure = {
    rule: rule as ChainRule,
    seq: Number(seqText),
    message: messageText
  };
  const cid = match[3];
  if (cid !== undefined) {
    failure.cid = cid;
  }
  return failure;
}

/**
 * Open a soulchain directory and verify the full chain.
 * Returns exit code 0 when valid, 1 when verification fails, 2 on I/O or corruption.
 */
export async function runVerify(options: VerifyOptions): Promise<number> {
  const doorPublicKeys =
    options.doorKeys === undefined
      ? undefined
      : options.doorKeys.map((encoded) => decodePublicKey(encoded));

  let store: FileSoulStore;
  try {
    const openOptions =
      doorPublicKeys === undefined ? undefined : { doorPublicKeys: doorPublicKeys };
    store = await FileSoulStore.open(options.dir, openOptions);
  } catch (error) {
    if (error instanceof CorruptionError) {
      const embedded = parseVerificationCorruption(error.message);
      if (embedded !== null) {
        printFailures([embedded]);
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
    const verifyOptions =
      doorPublicKeys === undefined ? undefined : { doorPublicKeys: doorPublicKeys };
    const result = await verifyChain(store, verifyOptions);

    if (result.valid) {
      return 0;
    }

    printFailures(result.failures);
    return EXIT_VERIFY_FAILED;
  } finally {
    await store.close();
  }
}
