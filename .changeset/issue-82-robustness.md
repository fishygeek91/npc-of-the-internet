---
"@npc/door-discord": patch
"@npc/door-web": patch
"@npc/door-sdk": patch
"@npc/runtime": patch
---

Shutdown still exits when stop fails, later resources still close, HTTP 500 bodies stay generic, transcript errors omit filesystem paths, and Brain logs record only reason and numeric status.
