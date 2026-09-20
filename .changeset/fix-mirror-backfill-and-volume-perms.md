---
"@npc/osp-core": patch
---

Fix two launch-blocking first-boot failures found during the Ghost production genesis ceremony:

- `DualSoulStore` now backfills the IPFS mirror from the authoritative file store at open. A genesis-seeded soulchain volume (LAUNCH.md §2 seeds only `chain.jsonl` + `blobs/`) previously made boot impossible — the mirror demanded genesis as its own first append while the runtime only appends new records (`first append requires seq 0 and prev null`). A mirror lagging after a crash between the file append and the IPFS append is caught up the same way; blob bytes are mirrored so the IPFS store can serve reads and CAR export. A mirror *ahead* of the file store is now an explicit `CorruptionError`; same-seq head divergence remains fatal as before.
- `ops/Dockerfile.runtime` pre-creates and chowns all three volume mountpoints (`/data/soulchain`, `/data/soulchain-ipfs`, `/data/published`) for uid 10001. The latter two were missed when T7.1 added them, so fresh volumes were root-owned and first boot failed with `EACCES: permission denied, mkdir '/data/soulchain-ipfs/blocks'`.
