# @npc/osp-core

## 0.6.0

### Minor Changes

- 4fcc330: Witnessed memory and travel between Doors (`door/0.2`). The Wanderer now lives at one Door at a time and moves on about once a day to a random Door that is online, never staying put while somewhere else is open. Its second Door is new: `@npc/door-web`, a public web porch that is open while the Wanderer is there and otherwise says where it went. No human approves memories any more, and there is no quarantine. At departure the Door where a memory formed co-signs it only after its independent AI witness has checked the memory against the Door's own record of what happened there. Witnessed memories are final as soon as they are appended. A memory the witness declines is kept only as a `rejected` record that gives the reason, never the text. Each residency's journal is written from witnessed memories only and is witnessed too (new osp/0.2 `journal` memory kind). Older `candidate` records still verify. On Discord, the review reactions are gone, and the bot posts when the Wanderer arrives and when it leaves.

  **Upgrade:** the runtime and both Doors must run the same release, because `door/0.2` is strict. Add `,web:home=<door pubkey>` to `ATLAS_DOOR_PUBKEYS`, using the same key as the Discord Door. The witness reuses the `NPC_BRAIN_*` settings when `NPC_BRAIN_PROVIDER=openai-compat`. The old `DISCORD_REVIEW_*`, `DOOR_COSIGN_RETAIN_*` and `NPC_QUARANTINE_*` settings no longer do anything. The daily move and the operator `depart` trigger are now on by default — delete any `NPC_RESIDENCY_OPERATOR_TRIGGER=0` / `NPC_RESIDENCY_MAX_MS=0` lines copied from an older `.env.example`, or they keep the Wanderer in place.

## 0.5.0

### Patch Changes

- e9b9e45: Harden the soulchain stores and verifier from the October osp-core review: a stale append lock left by a restarted container (same PID 1) no longer blocks recovery; `append` now enforces the full chain rules before writing, so it can never persist a record that makes the store unopenable; tombstones must reference an on-chain record and its blob (new `bad_tombstone` rule + vectors); torn blob/block files are replaced atomically; erased blobs are reconciled out of the IPFS mirror; `"__proto__"` keys are rejected; Ed25519 verification is strict RFC 8032; pin manifests must be canonical; an empty authoritative store with a populated mirror is refused; and IPFS `HEAD` is checked against (and repaired only after verifying) the seq-index.

  Round 2: the append lock now records the holder's hostname and process start time, so a live lock held by a worker thread, a second module instance, or another container sharing the volume is no longer stolen (a same-host, same-PID lock from a previous process is still cleared; a lock from another hostname cannot be probed and counts as live until it is an hour old; v0.4.3 locks keep the old behaviour); the IPFS mirror keeps an erased blob that a later live record re-put (it follows the file store); orphaned temp files older than an hour are removed from `blobs/` and the IPFS blockstore on writable open; new strict RFC 8032 vector `bad-soul-sig-small-order-key`. **Upgrade gate:** strict tombstone rule 12, `"__proto__"` rejection and strict RFC 8032 apply retroactively — run the new release's `osp verify` against a snapshot before switching `NPC_IMAGE_TAG` and do not deploy if it fails (RUNBOOK §4.3.1).

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.2

## 0.3.1

### Patch Changes

- 3d55b11: Fix two launch-blocking first-boot failures found during the Ghost production genesis ceremony:

  - `DualSoulStore` now backfills the IPFS mirror from the authoritative file store at open. A genesis-seeded soulchain volume (LAUNCH.md §2 seeds only `chain.jsonl` + `blobs/`) previously made boot impossible — the mirror demanded genesis as its own first append while the runtime only appends new records (`first append requires seq 0 and prev null`). A mirror lagging after a crash between the file append and the IPFS append is caught up the same way; blob bytes are mirrored so the IPFS store can serve reads and CAR export. A mirror _ahead_ of the file store is now an explicit `CorruptionError`; same-seq head divergence remains fatal as before.
  - `ops/Dockerfile.runtime` pre-creates and chowns all three volume mountpoints (`/data/soulchain`, `/data/soulchain-ipfs`, `/data/published`) for uid 10001. The latter two were missed when T7.1 added them, so fresh volumes were root-owned and first boot failed with `EACCES: permission denied, mkdir '/data/soulchain-ipfs/blocks'`.

## 0.3.0

## 0.2.2

## 0.2.1

## 0.2.0

### Minor Changes

- 3f36562: Add IpfsSoulStore (blockstore-fs) and DualSoulStore with shared conformance and CID identity.
- 5782dc6: Add pin-manifest + CAR export and osp CLI export-car / manifest / verify --from-ipfs.
- 2c7f13a: osp/0.2 runtime cutover: SoulStore side blobs, erase+tombstone guards, compose erased marker, Atlas journal blob resolve, migrate CLI + boot guard (#119 PR2)
- eb91666: osp/0.2 schema: side-blob memory refs, tombstone record type, dual-version verifyChain + migration vectors (#119 PR1)
- b9b96f6: Add outbound replication queue/drain (Storacha/Filebase CAR upload), DualSoulStore Ghost wiring, and Atlas CAR download hook.
- 403982e: Bind cosigner verification to residency Door keys; enforce PoP session continuity and presence conflicts in chain verify.

### Patch Changes

- 6a5d6ac: Reject dag-json reserved sole-key "/" objects at create/verify (§0.2); land IPFS store spec as normative with FileSoulStore conformance harness.
- cb20020: Harden FileSoulStore: verify on append, full writeSync loops, PID-aware recovery locks, load-time canonical bytes, and stricter ISO-UTC / fork_point schemas.
- de4ec18: Extract BlobDir, FileLock, and fsync helpers from FileSoulStore for reuse by IpfsSoulStore (T7.1). Store-internal modules are re-exported from the store barrel (`@internal`) for in-package SoulStore backends; package-root public API remains FileSoulStore-focused.

## 0.1.0

### Minor Changes

- 73f2d38: Add OSP record types, canonical JSON, Ed25519 signing, and CID helpers in osp-core (T1.1).
- 10d8f2d: Add append-only FileSoulStore (JSONL + blobs, fsync, locks) behind SoulStore interface (T1.2).
- 402210a: Add verifyChain/verifyRecords, schema hardening, and OSP conformance vectors (T1.3).
- fccf82b: Add osp CLI binary with init, verify, log, and show commands (T1.4).
- 846ad84: Add Brain interface, AnthropicBrain, FakeBrain, and Zod config loader (T2.1).
- e51ae2e: Read-only Atlas chain API and FileSoulStore.openReadOnly (T5.1).

### Patch Changes

- e4adc27: security: validate CID format before path join in FileSoulStore (#19).
- 1eececa: schema: tighten prev and drift.evidence to CidSchema (#24).
- e59d2e7: T1.4 CLI follow-up: log timestamps, CorruptionError failures, e2e gaps (#17).
- 949de8d: Quarantine lifecycle: candidate → shard/rejected with deferred Door commit (T3.2).
