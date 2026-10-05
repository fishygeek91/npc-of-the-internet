import { writeStdout } from "../io.js";

import { EXIT_USAGE, openReadOnlyStore } from "./read-only-store.js";

export { EXIT_USAGE };

/** Options for {@link runShow}. */
export type ShowOptions = {
  dir: string;
  cid: string;
  /** `doorId=base64url` bindings (repeatable `--door-key`) for cosigned records. */
  doorKeys?: readonly string[];
};

/**
 * Fetch, verify and pretty-print a single record by CID from a read-only open.
 *
 * Returns 0 on success or {@link EXIT_USAGE} when the directory or layout is missing or
 * a `--door-key` is malformed. Record lookup/verification errors propagate (the CLI maps
 * them to exit 2). Never creates files.
 */
export async function runShow(options: ShowOptions): Promise<number> {
  const opened = await openReadOnlyStore(options.dir, options.doorKeys);
  if ("exitCode" in opened) {
    return opened.exitCode;
  }
  const { store } = opened;
  try {
    const record = await store.get(options.cid);
    writeStdout(JSON.stringify(record, null, 2));
    return 0;
  } finally {
    await store.close();
  }
}
