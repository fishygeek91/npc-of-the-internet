import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { DualSoulStore } from "../src/index.js";
import { registerStoreConformance } from "./store-conformance.js";

registerStoreConformance({
  name: "DualSoulStore",
  open: async (dir) => {
    const fileDir = path.join(dir, "file");
    const ipfsDir = path.join(dir, "ipfs");
    await mkdir(fileDir, { recursive: true });
    await mkdir(ipfsDir, { recursive: true });
    return DualSoulStore.open(fileDir, ipfsDir);
  },
  supportsJsonlLayout: false,
  supportsLockTest: false
});
