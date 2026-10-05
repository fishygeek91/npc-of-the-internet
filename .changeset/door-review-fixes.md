---
"@npc/door-sdk": patch
"@npc/door-discord": patch
---

Door review fixes (2026-10): WS session server no longer crashes on long close reasons, unmasked/oversized frames (short fixed close reasons, per-socket error listeners, 256 KiB `maxPayload`); attest/commit co-signatures are bound to the request (attestation kind + residency; reviewed shard text via `text_hash`, single-use per chain position); outbound frames are replay- and freshness-checked (`msg_replay`); keycap reactions restricted to `[0-9#*]`. Discord: no mention pings (`allowedMentions` everywhere), 2000-char chunking, `failIfNotExists: false` replies, per-epoch bounded msg-id map, cosign review freshness checked before posting and duplicate reviews joined/rejected, gateway dispatch errors caught and logged.
