---
"@npc/osp-core": patch
"@npc/runtime": patch
"@npc/door-discord": patch
---

Import SHA-512 and HKDF from @noble/hashes 2 (`sha2.js`, `hkdf.js`). Digest bytes, signatures, and session keys stay the same.
