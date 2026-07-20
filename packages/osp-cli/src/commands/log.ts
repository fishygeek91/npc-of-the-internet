import { computeCid, FileSoulStore } from "@npc/osp-core";

import { formatLogLine } from "../log-format.js";
import { writeStdout } from "../io.js";

/** Exit code for usage errors and I/O failures. */
export const EXIT_USAGE = 2;

/**
 * Stream chain records to stdout without buffering the full chain in memory.
 */
export async function runLog(dir: string): Promise<void> {
  const store = await FileSoulStore.open(dir);
  try {
    for await (const record of store.iterate()) {
      const cid = await computeCid(record);
      writeStdout(formatLogLine(record, cid));
    }
  } finally {
    await store.close();
  }
}
