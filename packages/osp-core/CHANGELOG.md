# @npc/osp-core

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
