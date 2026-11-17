# @npc/atlas

## 0.6.0

### Minor Changes

- 4fcc330: Witnessed memory and travel between Doors (`door/0.2`). The Wanderer now lives at one Door at a time and moves on about once a day to a random Door that is online, never staying put while somewhere else is open. Its second Door is new: `@npc/door-web`, a public web porch that is open while the Wanderer is there and otherwise says where it went. No human approves memories any more, and there is no quarantine. At departure the Door where a memory formed co-signs it only after its independent AI witness has checked the memory against the Door's own record of what happened there. Witnessed memories are final as soon as they are appended. A memory the witness declines is kept only as a `rejected` record that gives the reason, never the text. Each residency's journal is written from witnessed memories only and is witnessed too (new osp/0.2 `journal` memory kind). Older `candidate` records still verify. On Discord, the review reactions are gone, and the bot posts when the Wanderer arrives and when it leaves.

  **Upgrade:** the runtime and both Doors must run the same release, because `door/0.2` is strict. Add `,web:home=<door pubkey>` to `ATLAS_DOOR_PUBKEYS`, using the same key as the Discord Door. The witness reuses the `NPC_BRAIN_*` settings when `NPC_BRAIN_PROVIDER=openai-compat`. The old `DISCORD_REVIEW_*`, `DOOR_COSIGN_RETAIN_*` and `NPC_QUARANTINE_*` settings no longer do anything. The daily move and the operator `depart` trigger are now on by default — delete any `NPC_RESIDENCY_OPERATOR_TRIGGER=0` / `NPC_RESIDENCY_MAX_MS=0` lines copied from an older `.env.example`, or they keep the Wanderer in place.

### Patch Changes

- Updated dependencies [4fcc330]
  - @npc/osp-core@0.6.0

## 0.5.0

### Patch Changes

- 17be3cb: Ops review fixes (2026-10).

  - **immune:** the screen's matching view now also strips default-ignorable characters (combining grapheme joiner, variation selectors) and combining marks, maps Hangul fillers / Braille blank to spaces, folds Cyrillic/Greek homoglyphs to Latin and any-script decimal digits to ASCII; PII allowlist entries are normalized the same way.
  - **osp-cli:** `osp log` / `osp show` open the chain read-only (a typo'd directory exits 2 instead of creating an empty chain) and accept repeatable `--door-key doorId=base64url` so cosigned chains verify.
  - **atlas:** `atlas-api` closes and exits 0 on SIGTERM/SIGINT; `ChainView` shares one in-flight load per chain fingerprint and briefly reuses an unreadable result.

  Ops-only (no package release needed): the backup sidecar no longer lists every remote blob per upload (`--files-from` for new blobs, full check only on startup/daily verify), defers heartbeat-only appends up to `BACKUP_HEARTBEAT_DEFER_SEC` (1 h), keeps the shrink-guard size in local state, takes `history/` rollback points at most once per `BACKUP_HISTORY_SEC` (1 day), propagates tombstone erasures to the remote, serializes cycles with a lock and exits promptly on SIGTERM. Compose services run with `init: true`; file secrets use `ops/compose.secrets.yml` (openai-compat, production) or `ops/compose.secrets.anthropic.yml`.

- Updated dependencies [e9b9e45]
  - @npc/osp-core@0.5.0

## 0.4.3

### Patch Changes

- @npc/osp-core@0.4.3

## 0.4.2

### Patch Changes

- 703d8d3: Dependency security floors so the release images pass the Trivy gate: `fastify` ^5.12.2 in atlas-api (CVE-2026-76169, CVE-2026-84428, CVE-2026-84469, CVE-2026-84504; was 5.10.0) and a root `undici@6` override ^6.28.1 for door-discord's discord.js tree (CVE-2026-19534; was 6.27.0). v0.4.1 published only the runtime and backup images.
  - @npc/osp-core@0.4.2

## 0.4.1

### Patch Changes

- a7bb321: Release images now apply OS security updates at build time (`apt-get upgrade` on the Node images, `apk upgrade` on the backup image). v0.4.0's images were never published: the Trivy gate blocked all four on base-layer CVEs that already had fixed packages (libpcre2 CVE-2026-103111; OpenSSL CVE-2026-75804 / CVE-2026-84782). No application code changes — v0.4.1 ships the v0.4.0 features.
  - @npc/osp-core@0.4.1

## 0.4.0

### Patch Changes

- @npc/osp-core@0.4.0

## 0.3.2

### Patch Changes

- 88b4000: Bump the root `fast-uri` override from the pinned `4.1.2` (itself now a fixable HIGH advisory) to `>=4.1.3` (resolves 4.2.1), clearing the Trivy gate that blocked the `npc-atlas-api` v0.3.1 image from publishing (#147). The vulnerable path was `packages/atlas > fastify > @fastify/ajv-compiler > ajv > fast-uri`; runtime, door-discord, and backup images were unaffected and published normally.
  - @npc/osp-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [3d55b11]
  - @npc/osp-core@0.3.1

## 0.3.0

### Patch Changes

- @npc/osp-core@0.3.0

## 0.2.2

### Patch Changes

- @npc/osp-core@0.2.2

## 0.2.1

### Patch Changes

- @npc/osp-core@0.2.1

## 0.2.0

### Minor Changes

- 2c7f13a: osp/0.2 runtime cutover: SoulStore side blobs, erase+tombstone guards, compose erased marker, Atlas journal blob resolve, migrate CLI + boot guard (#119 PR2)
- b9b96f6: Add outbound replication queue/drain (Storacha/Filebase CAR upload), DualSoulStore Ghost wiring, and Atlas CAR download hook.
- 403982e: Bind cosigner verification to residency Door keys; enforce PoP session continuity and presence conflicts in chain verify.
- 7350cc1: Neutralize journal XSS on the public site and harden the Atlas read API (path-free 503s, sleep state, journal pagination, CORS).

### Patch Changes

- Updated dependencies [6a5d6ac]
- Updated dependencies [3f36562]
- Updated dependencies [5782dc6]
- Updated dependencies [2c7f13a]
- Updated dependencies [eb91666]
- Updated dependencies [b9b96f6]
- Updated dependencies [cb20020]
- Updated dependencies [403982e]
- Updated dependencies [de4ec18]
  - @npc/osp-core@0.2.0

## 0.1.0

### Minor Changes

- 73f2d38: Add OSP record types, canonical JSON, Ed25519 signing, and CID helpers in osp-core (T1.1).
- 10d8f2d: Add append-only FileSoulStore (JSONL + blobs, fsync, locks) behind SoulStore interface (T1.2).
- 402210a: Add verifyChain/verifyRecords, schema hardening, and OSP conformance vectors (T1.3).
- fccf82b: Add osp CLI binary with init, verify, log, and show commands (T1.4).
- 846ad84: Add Brain interface, AnthropicBrain, FakeBrain, and Zod config loader (T2.1).
- e51ae2e: Read-only Atlas chain API and FileSoulStore.openReadOnly (T5.1).

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
