---
"@npc/door-web": minor
---

door-web checks a porch line only against the open arrival at this Door. A departed, superseded, or sleeping epoch fails, a malformed proof fails closed, and a failed export fetch clears the ETag so the next request is a full GET. The porch page does not call this yet.
