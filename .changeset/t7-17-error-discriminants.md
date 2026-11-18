---
"@npc/osp-core": patch
"@npc/door-sdk": patch
"@npc/runtime": patch
---

Verification and Door errors carry exhaustive discriminants (`VerificationError.reason`, `DoorError.code`). Shard text length is one shared constant. Known messages and chain-rule ids are unchanged. An unrecognized Door wire `error.code` becomes `door_unavailable` with `details.unrecognized_code`; the message and HTTP status are kept.
