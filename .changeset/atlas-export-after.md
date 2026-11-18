---
"@npc/atlas": minor
---

`GET /chain/export` accepts `after`, a record CID, and returns the records after it plus the journal blobs they reference. An unknown CID is `export_after_unknown`. Each tail has its own ETag.
