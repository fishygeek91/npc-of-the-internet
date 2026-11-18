---
"@npc/runtime": patch
"@npc/door-discord": patch
---

Move `@noble/ed25519` to devDependencies. Production code signs through `@npc/osp-core`. Scripts and test helpers still import it directly.
