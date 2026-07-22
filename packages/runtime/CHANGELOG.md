# @npc/runtime

## 0.1.0

### Minor Changes

- 73f2d38: Add OSP record types, canonical JSON, Ed25519 signing, and CID helpers in osp-core (T1.1).
- 10d8f2d: Add append-only FileSoulStore (JSONL + blobs, fsync, locks) behind SoulStore interface (T1.2).
- 402210a: Add verifyChain/verifyRecords, schema hardening, and OSP conformance vectors (T1.3).
- fccf82b: Add osp CLI binary with init, verify, log, and show commands (T1.4).
- 846ad84: Add Brain interface, AnthropicBrain, FakeBrain, and Zod config loader (T2.1).
- 609a904: Add composeSelf Self-Composer: deterministic soulchain → systemPrompt + memoryIndex (T2.2).
- 1eedcfb: Add distillTranscripts Distiller: transcripts → 5–20 candidate shards via Brain (T2.3).
- 4ad0d60: Session loop with Keyring, HKDF session-key derivation, arrival/heartbeat attestations, and Door stub integration tests (T2.4).
- 1ab57e2: Departure + manual handover: Session.depart, two-phase Door cosign, wanderer move CLI, residency journal (T2.5).
- 5830f2b: Add immune static screen (PII + injection) and wire it into Distiller shards and session inbound (T3.1).
- 949de8d: Quarantine lifecycle: candidate → shard/rejected with deferred Door commit (T3.2).
- 57b101c: Door API contract library: Zod schemas, signing helpers, Door core with HostPolicy, in-process/HTTP/ws transports; runtime re-exports wire types and DoorStub wraps SDK Door (T4.1).

### Patch Changes

- 7f737e5: npc-runtime residency daemon: cross-container Door Session over HTTP/WS with graceful SIGTERM.
- Updated dependencies [e4adc27]
- Updated dependencies [1eececa]
- Updated dependencies [73f2d38]
- Updated dependencies [10d8f2d]
- Updated dependencies [402210a]
- Updated dependencies [e59d2e7]
- Updated dependencies [fccf82b]
- Updated dependencies [846ad84]
- Updated dependencies [5830f2b]
- Updated dependencies [949de8d]
- Updated dependencies [57b101c]
- Updated dependencies [e51ae2e]
- Updated dependencies [a732224]
- Updated dependencies [f5353f6]
  - @npc/osp-core@0.1.0
  - @npc/immune@0.1.0
  - @npc/door-sdk@0.1.0
