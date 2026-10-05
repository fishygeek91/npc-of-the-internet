import { computeCid } from "@npc/osp-core";

import { writeStderr, writeStdout } from "../io.js";
import { formatLogLine } from "../log-format.js";

import { EXIT_USAGE, openReadOnlyStore } from "./read-only-store.js";

export { EXIT_USAGE };

/** Options for {@link runLog}. */
export type LogOptions = {
  dir: string;
  /** `doorId=base64url` bindings (repeatable `--door-key`) for cosigned records. */
  doorKeys?: readonly string[];
};

/**
 * Print one line per chain record, genesis to head, from a read-only open.
 *
 * Returns 0 after listing (a chain that fails verification is still listed, with a
 * stderr warning pointing at `osp verify`), or {@link EXIT_USAGE} when the directory or
 * layout is missing or a `--door-key` is malformed. Never creates files.
 */
export async function runLog(options: LogOptions): Promise<number> {
  const opened = await openReadOnlyStore(options.dir, options.doorKeys);
  if ("exitCode" in opened) {
    return opened.exitCode;
  }
  const { store } = opened;
  try {
    for await (const record of store.iterate()) {
      const cid = await computeCid(record);
      writeStdout(formatLogLine(record, cid));
    }
    const verification = store.verification();
    if (!verification.valid) {
      writeStderr(
        `warning: chain verification failed (${verification.failures.length} failure(s)); run \`osp verify <dir> --door-key <doorId=base64url>...\` for details`
      );
    }
    return 0;
  } finally {
    await store.close();
  }
}
