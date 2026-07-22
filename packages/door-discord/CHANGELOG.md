# @npc/door-discord

## 0.1.0

### Minor Changes

- 73f2d38: Add OSP record types, canonical JSON, Ed25519 signing, and CID helpers in osp-core (T1.1).
- 10d8f2d: Add append-only FileSoulStore (JSONL + blobs, fsync, locks) behind SoulStore interface (T1.2).
- 402210a: Add verifyChain/verifyRecords, schema hardening, and OSP conformance vectors (T1.3).
- fccf82b: Add osp CLI binary with init, verify, log, and show commands (T1.4).
- 846ad84: Add Brain interface, AnthropicBrain, FakeBrain, and Zod config loader (T2.1).
- ff53d93: Discord Door adapter: channel-bound residency, FakeGateway tests, cosign review (timeout rejects), MANUAL_TEST harness (T4.2).

### Patch Changes

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
- Updated dependencies [57b101c]
- Updated dependencies [e51ae2e]
- Updated dependencies [a732224]
- Updated dependencies [f5353f6]
  - @npc/osp-core@0.1.0
  - @npc/door-sdk@0.1.0
