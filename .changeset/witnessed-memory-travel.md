---
"@npc/osp-core": minor
"@npc/osp-cli": minor
"@npc/runtime": minor
"@npc/door-sdk": minor
"@npc/door-discord": minor
"@npc/door-web": minor
"@npc/atlas": minor
"@npc/atlas-site": minor
---

Witnessed memory and travel between Doors (`door/0.2`). The Wanderer now lives at one Door at a time and moves on about once a day to a random Door that is online, never staying put while somewhere else is open. Its second Door is new: `@npc/door-web`, a public web porch that is open while the Wanderer is there and otherwise says where it went. No human approves memories any more, and there is no quarantine. At departure the Door where a memory formed co-signs it only after its independent AI witness has checked the memory against the Door's own record of what happened there. Witnessed memories are final as soon as they are appended. A memory the witness declines is kept only as a `rejected` record that gives the reason, never the text. Each residency's journal is written from witnessed memories only and is witnessed too (new osp/0.2 `journal` memory kind). Older `candidate` records still verify. On Discord, the review reactions are gone, and the bot posts when the Wanderer arrives and when it leaves.

**Upgrade:** the runtime and both Doors must run the same release, because `door/0.2` is strict. Add `,web:home=<door pubkey>` to `ATLAS_DOOR_PUBKEYS`, using the same key as the Discord Door. The witness reuses the `NPC_BRAIN_*` settings when `NPC_BRAIN_PROVIDER=openai-compat`. The old `DISCORD_REVIEW_*`, `DOOR_COSIGN_RETAIN_*` and `NPC_QUARANTINE_*` settings no longer do anything. The daily move and the operator `depart` trigger are now on by default — delete any `NPC_RESIDENCY_OPERATOR_TRIGGER=0` / `NPC_RESIDENCY_MAX_MS=0` lines copied from an older `.env.example`, or they keep the Wanderer in place.
