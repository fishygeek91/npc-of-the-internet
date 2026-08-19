# @npc/door-sdk

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

### Patch Changes

- d8d7e36: Verify cosign session binding and signatures before Discord review-gate posts (fixes unauthenticated attacker text in host channel, #65).
- 019ff29: Harden Door protocol: arrival epoch replay/supersession + issued_at skew, HTTP body size cap (413), client verifies Door response signatures, WS closes on depart/supersede (#66).
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
- 949de8d: Quarantine lifecycle: candidate → shard/rejected with deferred Door commit (T3.2).
- 57b101c: Door API contract library: Zod schemas, signing helpers, Door core with HostPolicy, in-process/HTTP/ws transports; runtime re-exports wire types and DoorStub wraps SDK Door (T4.1).

### Patch Changes

- a732224: HttpDoorConnection and WsDoorSessionClient for networked Door Session transport.
- f5353f6: Coalesce Door WebSocket session onto the HTTP listener for Ghost compose.
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
