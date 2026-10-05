---
"@npc/runtime": patch
---

Runtime review fixes (2026-10):

- Attention prompt: untrusted room text is substituted with a single-pass replacer function, so `` $` ``, `$'`, `$&` and `$$` in a message can no longer expand into a forged left-edge room-log entry. The distiller retry prompt uses a replacer function too.
- Attention decisions: `<think>…</think>` (and similar) reasoning is stripped before parsing; the last balanced top-level JSON object that matches the decision shape wins; unparseable output is only spoken when it is plain prose with no `{` and no reasoning marker, so reasoning or broken JSON is never sent to the room.
- Depart waits for an in-flight inbound decision, and `observe` / `handleInbound` drop a Brain result that lands after `stop()` (no transcript record, no signed outbound).
- Replication drain: `stop()` awaits the tick that is actually running (concurrent ticks join it); CAR uploads abort after a configurable timeout (`DEFAULT_CAR_UPLOAD_TIMEOUT_MS`, 120 s).
- Room log: display names are NFKC-normalized, stripped of control/format/line-separator characters, and can never render as `YOU` (`YOU.`, `ＹＯＵ`, `Y O U`, …); continuation lines are indented after every Unicode line break.
- Selective attention keeps observed entries (and their `addressed` flag) in the pending batch even when a burst evicts them from the bounded room log mid-decision.
- Distill measures shard length in UTF-16 units (what the Door's `CandidateShardSchema` enforces), so emoji-heavy shards no longer abort departure.
- Daemon: a boot failure after the store opens releases the WS client, session timer, replication drain and store; shutdown runs every step even if one throws.
