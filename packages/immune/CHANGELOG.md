# @npc/immune

## 0.6.0

## 0.5.0

### Patch Changes

- 17be3cb: Ops review fixes (2026-10).

  - **immune:** the screen's matching view now also strips default-ignorable characters (combining grapheme joiner, variation selectors) and combining marks, maps Hangul fillers / Braille blank to spaces, folds Cyrillic/Greek homoglyphs to Latin and any-script decimal digits to ASCII; PII allowlist entries are normalized the same way.
  - **osp-cli:** `osp log` / `osp show` open the chain read-only (a typo'd directory exits 2 instead of creating an empty chain) and accept repeatable `--door-key doorId=base64url` so cosigned chains verify.
  - **atlas:** `atlas-api` closes and exits 0 on SIGTERM/SIGINT; `ChainView` shares one in-flight load per chain fingerprint and briefly reuses an unreadable result.

  Ops-only (no package release needed): the backup sidecar no longer lists every remote blob per upload (`--files-from` for new blobs, full check only on startup/daily verify), defers heartbeat-only appends up to `BACKUP_HEARTBEAT_DEFER_SEC` (1 h), keeps the shrink-guard size in local state, takes `history/` rollback points at most once per `BACKUP_HISTORY_SEC` (1 day), propagates tombstone erasures to the remote, serializes cycles with a lock and exits promptly on SIGTERM. Compose services run with `init: true`; file secrets use `ops/compose.secrets.yml` (openai-compat, production) or `ops/compose.secrets.anthropic.yml`.

## 0.4.3

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.2

## 0.2.1

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
