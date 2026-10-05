---
"@npc/runtime": patch
---

Ops-only (ships the backup image): the backup sidecar treated rclone's empty `lsjson` result on bucket remotes (B2/S3 print `[` and `]` on separate lines with exit 0 when the object is missing) as unparseable, so with no remote `chain.jsonl` it refused every chain upload — blobs were backed up but the chain tip never was. Empty multi-line arrays now count as size 0. The budget test's rclone shim now mimics bucket-remote `lsjson` semantics, and fails against the old script.
