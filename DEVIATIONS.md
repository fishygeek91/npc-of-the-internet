# DEVIATIONS.md

Smallest workarounds when ENGINEERING.md or spec prose blocks implementation. One paragraph per entry; link the task if applicable.

## T1.1 — CID base32 prefix (`bafy` vs `bagu`) — **resolved**

**Resolved (T1.3):** `spec/osp/records.md` and TASKS.md now use `bagu…` examples consistent with dag-json + sha2-256. Implementation was already correct.

## T2.5 — `/door/cosign` shard co-signer payload — **resolved (spec)**

**Resolved (T2.5):** An earlier draft of `spec/door/api.md` placed `door_cosig` over `{ shard_id, text, door_id, epoch }` directly into soulchain `cosigners`, which conflicts with OSP (`verifyRecord` verifies cosigners over envelope `core` bytes; memory `body` has no `shard_id`). Spec now documents a two-phase flow: **review** (approve/reject; optional `host_audit_sig` not in `cosigners`) then **commit** (`door_cosig` over raw OSP `core`, same as `/door/attest`). `spec/osp/records.md` append-order prose aligned.

**Contract (T2.5 / revisit T3.2):** If the host rejects **all** candidate shards, `Session.depart` still emits the journal file and appends departure + travel, but the journal never lands on-chain (no approved memory record). Quarantine (T3.2) is the natural place to revisit retaining rejected material.

## Residency lifecycle — commit co-signing only in the travel gap (2026-10) — **resolved**

**Was:** the reference Door kept one in-memory cosign review state, bound to the last reviewed epoch and cleared on every arrival (and lost on restart), so the daemon's commit sweep had to run in the travel gap and config capped `NPC_QUARANTINE_WINDOW_MS` at 1 h while the sweep was on. **Resolved (spec + door-sdk + door-discord + runtime):** `spec/door/api.md` now defines **Review retention** behind the additive `door/0.1` capability `cosign.past_epochs`: a Door keeps completed reviews per epoch across later arrivals (door-sdk: last 16 epochs / 7 days, configurable), optionally durable (`FileCosignStateStore`; door-discord `DOOR_STATE_DIR`, a `door-state` volume in Ghost compose), and accepts commits for a retained past epoch authenticated by that epoch's session key with every binding rule unchanged; an unretained past epoch answers `review_not_retained` (410). The runtime re-derives the past epoch's session key from the soul key (no extra secret retained) and, against such a Door, runs the commit sweep on a timer during live residency with the default 24 h window; against a legacy Door it keeps the travel-gap sweep and refuses (at boot, after `hello`, before any append) a window over 1 h. Still open: a production `wanderer quarantine flag` path through the daemon (it holds the append lock) — until then the window is a delay rather than a veto; host review is the veto.

## Residency lifecycle — journal generated from approved shards only (2026-10)

`Session.depart` previously generated the journal from **all** distilled candidates before host review; the journal is published on chain (journal side blob on the first committed shard), so prose the host rejected could leak through the journal's paraphrase. The journal is now generated after review from the host-approved shards only (with zero approved shards it is still written to `journalDir` and never reaches the chain, per the T2.5 contract above). Not a spec change — the spec does not define journal inputs — recorded because it changes depart's order of operations (review before journal).
