---
"@npc/runtime": patch
"@npc/door-discord": patch
---

Budget status publish failures log the env var and an error code, a failed write removes its temp file, and the Door opens the snapshot without following a symlink or blocking on a FIFO.
