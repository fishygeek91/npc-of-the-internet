---
"@npc/osp-core": patch
---

Migrate osp-core to Zod 4 and emit draft-07 JSON Schema with z.toJSONSchema. Record validation is unchanged; discriminated unions in the published schemas use oneOf.
