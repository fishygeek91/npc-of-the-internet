import { IpfsSoulStore } from "../src/index.js";
import { registerStoreConformance } from "./store-conformance.js";

registerStoreConformance({
  name: "IpfsSoulStore",
  open: (dir) => IpfsSoulStore.open(dir),
  supportsJsonlLayout: false,
  lockFile: "LOCK"
});
