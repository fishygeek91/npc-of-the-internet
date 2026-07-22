# @npc/osp-core

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
