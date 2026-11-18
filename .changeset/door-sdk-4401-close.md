---
"@npc/door-sdk": patch
---

A Door WebSocket bind rejection (close code 4401) stays a fatal session failure when the socket also emits `error`. The server sends the 101 response and that close frame in one write, and it no longer aborts the close handshake.
