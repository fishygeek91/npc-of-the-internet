---
"@npc/door-web": minor
---

The first full verify on the porch page and the shrine runs in a blob-URL worker built from the same classic bundle. Records that worker accepted are parsed on the main thread in chunks that yield about every 50 ms. If the worker cannot start or it errors, verification continues in those chunks. `GET /shrine.js` sends `Access-Control-Allow-Origin: *` and does not send credentials; no other static asset sends that header.
