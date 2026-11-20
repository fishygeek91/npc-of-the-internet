---
"@npc/door-web": minor
---

The porch forwards a validated `after` on `GET /chain/export`, keeps at most 16 tail bodies and 16 MiB of them, and answers extra concurrent tail fetches with `503` `atlas_busy`.
