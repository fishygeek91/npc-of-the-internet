# @npc/door-discord

## 0.2.0

### Patch Changes

- 2c7f13a: osp/0.2 runtime cutover: SoulStore side blobs, erase+tombstone guards, compose erased marker, Atlas journal blob resolve, migrate CLI + boot guard (#119 PR2)
- d8d7e36: Verify cosign session binding and signatures before Discord review-gate posts (fixes unauthenticated attacker text in host channel, #65).
- 3dcf737: Ops hardening (#72): immune NFKC/format-char normalize + bare base64 screen; door-discord rate-limit channel-first + idle eviction; ANTHROPIC_API_KEY_FILE / DISCORD_BOT_TOKEN_FILE secret loading.
- 53d007d: Loud, actionable permission errors when soul/door key files are unreadable (uid/gid 10001 mount contract, #84).
- Updated dependencies [6a5d6ac]
- Updated dependencies [3f36562]
- Updated dependencies [5782dc6]
- Updated dependencies [2c7f13a]
- Updated dependencies [eb91666]
- Updated dependencies [b9b96f6]
- Updated dependencies [d8d7e36]
- Updated dependencies [019ff29]
- Updated dependencies [cb20020]
- Updated dependencies [403982e]
- Updated dependencies [de4ec18]
  - @npc/osp-core@0.2.0
  - @npc/door-sdk@0.2.0

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
