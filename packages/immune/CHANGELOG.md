# @npc/immune

## 0.2.0

### Patch Changes

- 3dcf737: Ops hardening (#72): immune NFKC/format-char normalize + bare base64 screen; door-discord rate-limit channel-first + idle eviction; ANTHROPIC_API_KEY_FILE / DISCORD_BOT_TOKEN_FILE secret loading.

## 0.1.0

### Minor Changes

- 73f2d38: Add OSP record types, canonical JSON, Ed25519 signing, and CID helpers in osp-core (T1.1).
- 10d8f2d: Add append-only FileSoulStore (JSONL + blobs, fsync, locks) behind SoulStore interface (T1.2).
- 402210a: Add verifyChain/verifyRecords, schema hardening, and OSP conformance vectors (T1.3).
- fccf82b: Add osp CLI binary with init, verify, log, and show commands (T1.4).
- 846ad84: Add Brain interface, AnthropicBrain, FakeBrain, and Zod config loader (T2.1).
- 5830f2b: Add immune static screen (PII + injection) and wire it into Distiller shards and session inbound (T3.1).
