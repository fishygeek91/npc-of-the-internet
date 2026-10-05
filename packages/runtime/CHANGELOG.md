# @npc/runtime

## 0.4.2

### Patch Changes

- @npc/osp-core@0.4.2
- @npc/immune@0.4.2
- @npc/door-sdk@0.4.2

## 0.4.1

### Patch Changes

- a7bb321: Release images now apply OS security updates at build time (`apt-get upgrade` on the Node images, `apk upgrade` on the backup image). v0.4.0's images were never published: the Trivy gate blocked all four on base-layer CVEs that already had fixed packages (libpcre2 CVE-2026-103111; OpenSSL CVE-2026-75804 / CVE-2026-84782). No application code changes — v0.4.1 ships the v0.4.0 features.
  - @npc/osp-core@0.4.1
  - @npc/immune@0.4.1
  - @npc/door-sdk@0.4.1

## 0.4.0

### Minor Changes

- 617cc56: Selective attention, reactions, and live residency transcript.

  - door-sdk: additive door/0.1 capabilities `session.reactions` (outbound `reaction: { emoji, target_msg_id }`, text-less reaction frames) and `session.addressing` (inbound `addressed`). Spec updated in `spec/door/api.md`.
  - runtime: `Session.observe` — the Wanderer reads a room log and decides to speak, react, both, or stay silent (one Brain call per burst, deterministic floor guard). `NPC_ATTENTION_MODE=selective|always` (default `selective`). New `ResidencyTranscript` records observed + spoken lines in memory for `depart()` distillation (WHITEPAPER §3.2).
  - door-discord: advertises both capabilities; addressed detection (@mention / reply to the Wanderer), msg_id ↔ Discord id mapping for threaded replies and reactions, typing indicator, and screen-safe mention rendering (raw `@name` would trip the immune `pii.handle` screen).

  Deploy the runtime and door-discord images together: a pre-release runtime rejects a `hello` that lists the new capability values.

### Patch Changes

- Updated dependencies [617cc56]
  - @npc/door-sdk@0.4.0
  - @npc/osp-core@0.4.0
  - @npc/immune@0.4.0

## 0.3.2

### Patch Changes

- @npc/osp-core@0.3.2
- @npc/immune@0.3.2
- @npc/door-sdk@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [3d55b11]
  - @npc/osp-core@0.3.1
  - @npc/door-sdk@0.3.1
  - @npc/immune@0.3.1

## 0.3.0

### Minor Changes

- de57bf0: Add OpenAI-compatible Brain so provider choice (including OpenRouter) is env-only, with usage on every completion.

### Patch Changes

- @npc/osp-core@0.3.0
- @npc/immune@0.3.0
- @npc/door-sdk@0.3.0

## 0.2.2

### Patch Changes

- 65c93f4: Strip unused Node base-image npm from runtime images; pin patched `fast-uri`; aggregate per-package release notes when osp-core section is empty.
  - @npc/osp-core@0.2.2
  - @npc/immune@0.2.2
  - @npc/door-sdk@0.2.2

## 0.2.1

### Patch Changes

- 592486d: Release CI: Trivy gates on fixable CVEs only and scans before push.
  - @npc/osp-core@0.2.1
  - @npc/immune@0.2.1
  - @npc/door-sdk@0.2.1

## 0.2.0

### Minor Changes

- 2c7f13a: osp/0.2 runtime cutover: SoulStore side blobs, erase+tombstone guards, compose erased marker, Atlas journal blob resolve, migrate CLI + boot guard (#119 PR2)
- b9b96f6: Add outbound replication queue/drain (Storacha/Filebase CAR upload), DualSoulStore Ghost wiring, and Atlas CAR download hook.
- 403982e: Bind cosigner verification to residency Door keys; enforce PoP session continuity and presence conflicts in chain verify.

### Patch Changes

- b189396: Harden depart/distill/quarantine: retryable departing session, destroy transcript after read, screen transcript lines, filter Door review decisions, and quarantine commit TOCTOU + already_rejected flag.
- 96db7f2: Serialize inbound Brain handling, surface heartbeat door/append failures, and floor arrival epochs with Door hello.active_epoch after mid-arrival crashes.
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
- Updated dependencies [3dcf737]
- Updated dependencies [de4ec18]
  - @npc/osp-core@0.2.0
  - @npc/door-sdk@0.2.0
  - @npc/immune@0.2.0

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
