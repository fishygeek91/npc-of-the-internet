---
"@npc/osp-core": patch
---

Extract BlobDir, FileLock, and fsync helpers from FileSoulStore for reuse by IpfsSoulStore (T7.1). Store-internal modules are re-exported from the store barrel (`@internal`) for in-package SoulStore backends; package-root public API remains FileSoulStore-focused.
