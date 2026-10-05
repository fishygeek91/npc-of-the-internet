---
"@npc/immune": patch
"@npc/osp-cli": patch
"@npc/atlas": patch
---

Ops review fixes (2026-10).

- **immune:** the screen's matching view now also strips default-ignorable characters (combining grapheme joiner, variation selectors) and combining marks, maps Hangul fillers / Braille blank to spaces, folds Cyrillic/Greek homoglyphs to Latin and any-script decimal digits to ASCII; PII allowlist entries are normalized the same way.
- **osp-cli:** `osp log` / `osp show` open the chain read-only (a typo'd directory exits 2 instead of creating an empty chain) and accept repeatable `--door-key doorId=base64url` so cosigned chains verify.
- **atlas:** `atlas-api` closes and exits 0 on SIGTERM/SIGINT; `ChainView` shares one in-flight load per chain fingerprint and briefly reuses an unreadable result.

Ops-only (no package release needed): the backup sidecar no longer lists every remote blob per upload (`--files-from` for new blobs, full check only on startup/daily verify), defers heartbeat-only appends up to `BACKUP_HEARTBEAT_DEFER_SEC` (1 h), keeps the shrink-guard size in local state, takes `history/` rollback points at most once per `BACKUP_HISTORY_SEC` (1 day), propagates tombstone erasures to the remote, serializes cycles with a lock and exits promptly on SIGTERM. Compose services run with `init: true`; file secrets use `ops/compose.secrets.yml` (openai-compat, production) or `ops/compose.secrets.anthropic.yml`.
