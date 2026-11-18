---
"@npc/door-sdk": patch
---

A Door WebSocket bind rejection (close code 4401) stays a fatal session failure when the socket also emits `error`, and the server no longer aborts that close handshake.
