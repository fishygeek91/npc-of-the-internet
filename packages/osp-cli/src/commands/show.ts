import { FileSoulStore } from "@npc/osp-core";

import { writeStdout } from "../io.js";

/** Exit code for usage errors and I/O failures. */
export const EXIT_USAGE = 2;

/** Options for {@link runShow}. */
export type ShowOptions = {
  dir: string;
  cid: string;
};

/** Fetch and pretty-print a single record by CID. */
export async function runShow(options: ShowOptions): Promise<void> {
  const store = await FileSoulStore.open(options.dir);
  try {
    const record = await store.get(options.cid);
    writeStdout(JSON.stringify(record, null, 2));
  } finally {
    await store.close();
  }
}
