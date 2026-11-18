---
"@npc/osp-core": patch
"@npc/runtime": patch
"@npc/door-discord": patch
"@npc/door-web": patch
---

Private-key files are parsed once in osp-core (`parsePrivateKeyBytes`); soul and Door loaders and the preflight helper use that parser and `publicKeyFromPrivate`.
