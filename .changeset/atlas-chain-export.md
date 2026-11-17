---
"@npc/atlas": minor
---

Atlas serves `GET /chain/export` so a browser can verify the soulchain: full records in order, door public keys only, and journal blobs. Tombstoned journal blobs are omitted. Responses carry an `ETag` for revalidation.
