# @npc/atlas-site

## 0.6.0

### Minor Changes

- 4fcc330: Witnessed memory and travel between Doors (`door/0.2`). The Wanderer now lives at one Door at a time and moves on about once a day to a random Door that is online, never staying put while somewhere else is open. Its second Door is new: `@npc/door-web`, a public web porch that is open while the Wanderer is there and otherwise says where it went. No human approves memories any more, and there is no quarantine. At departure the Door where a memory formed co-signs it only after its independent AI witness has checked the memory against the Door's own record of what happened there. Witnessed memories are final as soon as they are appended. A memory the witness declines is kept only as a `rejected` record that gives the reason, never the text. Each residency's journal is written from witnessed memories only and is witnessed too (new osp/0.2 `journal` memory kind). Older `candidate` records still verify. On Discord, the review reactions are gone, and the bot posts when the Wanderer arrives and when it leaves.

  **Upgrade:** the runtime and both Doors must run the same release, because `door/0.2` is strict. Add `,web:home=<door pubkey>` to `ATLAS_DOOR_PUBKEYS`, using the same key as the Discord Door. The witness reuses the `NPC_BRAIN_*` settings when `NPC_BRAIN_PROVIDER=openai-compat`. The old `DISCORD_REVIEW_*`, `DOOR_COSIGN_RETAIN_*` and `NPC_QUARANTINE_*` settings no longer do anything. The daily move and the operator `depart` trigger are now on by default — delete any `NPC_RESIDENCY_OPERATOR_TRIGGER=0` / `NPC_RESIDENCY_MAX_MS=0` lines copied from an older `.env.example`, or they keep the Wanderer in place.

### Patch Changes

- Updated dependencies [4fcc330]
  - @npc/osp-core@0.6.0
  - @npc/atlas@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [17be3cb]
- Updated dependencies [e9b9e45]
  - @npc/atlas@0.5.0
  - @npc/osp-core@0.5.0

## 0.4.3

### Patch Changes

- @npc/osp-core@0.4.3
- @npc/atlas@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies [703d8d3]
  - @npc/atlas@0.4.2
  - @npc/osp-core@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [a7bb321]
  - @npc/atlas@0.4.1
  - @npc/osp-core@0.4.1

## 0.4.0

### Patch Changes

- @npc/osp-core@0.4.0
- @npc/atlas@0.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [88b4000]
  - @npc/atlas@0.3.2
  - @npc/osp-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [3d55b11]
  - @npc/osp-core@0.3.1
  - @npc/atlas@0.3.1

## 0.3.0

### Patch Changes

- @npc/osp-core@0.3.0
- @npc/atlas@0.3.0

## 0.2.2

### Patch Changes

- @npc/osp-core@0.2.2
- @npc/atlas@0.2.2

## 0.2.1

### Patch Changes

- @npc/osp-core@0.2.1
- @npc/atlas@0.2.1

## 0.2.0

### Minor Changes

- 403982e: Bind cosigner verification to residency Door keys; enforce PoP session continuity and presence conflicts in chain verify.

### Patch Changes

- 2c7f13a: osp/0.2 runtime cutover: SoulStore side blobs, erase+tombstone guards, compose erased marker, Atlas journal blob resolve, migrate CLI + boot guard (#119 PR2)
- 7350cc1: Neutralize journal XSS on the public site and harden the Atlas read API (path-free 503s, sleep state, journal pagination, CORS).
- Updated dependencies [6a5d6ac]
- Updated dependencies [3f36562]
- Updated dependencies [5782dc6]
- Updated dependencies [2c7f13a]
- Updated dependencies [eb91666]
- Updated dependencies [b9b96f6]
- Updated dependencies [cb20020]
- Updated dependencies [403982e]
- Updated dependencies [7350cc1]
- Updated dependencies [de4ec18]
  - @npc/osp-core@0.2.0
  - @npc/atlas@0.2.0

## 0.1.0

### Minor Changes

- f5b26db: Astro static Atlas site built from soulchain at build time (T5.2).

### Patch Changes

- Updated dependencies [e4adc27]
- Updated dependencies [1eececa]
- Updated dependencies [73f2d38]
- Updated dependencies [10d8f2d]
- Updated dependencies [402210a]
- Updated dependencies [e59d2e7]
- Updated dependencies [fccf82b]
- Updated dependencies [846ad84]
- Updated dependencies [949de8d]
- Updated dependencies [e51ae2e]
  - @npc/osp-core@0.1.0
  - @npc/atlas@0.1.0
