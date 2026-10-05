---
"@npc/door-sdk": patch
"@npc/door-discord": patch
"@npc/runtime": patch
---

Round-2 runtime/Door review fixes (2026-10):

- Door cosign: `issued_at` freshness is checked once, on receipt; `ReviewGatedDoor` finishes a review via `cosignReceivedFresh` (session/epoch/signature re-verified, clock not), so a host review longer than the 5-minute skew window no longer fails `timestamp_stale` after the shards were posted.
- Review retries are matched by `(epoch, session_pubkey, {shard_id, text} set)` instead of the request signature: a re-signed retry joins the in-flight review, and after completion gets the stored signed response instead of `epoch_closed`. A different shard set is still `review_pending` / `epoch_closed`.
- Commit: a retry at the same `seq` with a byte-identical `core` returns the stored co-signature (idempotent) instead of `shard_not_approved`; the runtime reuses the core it prepared for a chain position (same `distilled_at`/journal refs) when retrying.
- `HttpDoorConnection`: explicit cosign-review timeout (`DEFAULT_COSIGN_REVIEW_TIMEOUT_MS`, 290 s, option `cosignReviewTimeoutMs`); door-discord `DISCORD_REVIEW_TIMEOUT_MS` default lowered to 240 s.
- Attention: reasoning tags inside the decision's JSON object (`{"say":"try <think> tags"}`) are content, not reasoning, and no longer erase the answer.
- Room log: display names keep their real text (NFKC + invisible/control stripping, grapheme-safe truncation, ZWJ kept inside emoji/complex-script sequences); the immune screen's lossy normalizer is used only for the `YOU` impersonation check.
