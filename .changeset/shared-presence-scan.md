---
"@npc/osp-core": minor
"@npc/atlas": minor
"@npc/door-web": minor
---

Atlas `GET /state`, the porch, and the shrine badge share one presence scan (`scanPresence`) and the per-epoch arrival lookup (`arrivalForEpoch`). A porch line still checks the arrival `session_pubkey` for its own epoch.
