import { FileSoulStore } from "../src/index.js";
import { registerStoreConformance } from "./store-conformance.js";

registerStoreConformance({
  name: "FileSoulStore",
  open: (dir) => FileSoulStore.open(dir),
  supportsJsonlLayout: true,
  lockFile: ".append.lock"
});
