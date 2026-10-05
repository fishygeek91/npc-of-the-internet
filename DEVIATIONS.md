# DEVIATIONS.md

Smallest workarounds when ENGINEERING.md or spec prose blocks implementation. One paragraph per entry; link the task if applicable.

## T1.1 — CID base32 prefix (`bafy` vs `bagu`) — **resolved**

**Resolved (T1.3):** `spec/osp/records.md` and TASKS.md now use `bagu…` examples consistent with dag-json + sha2-256. Implementation was already correct.

## T2.5 — `/door/cosign` shard co-signer payload — **resolved (spec)**

**Resolved (T2.5):** An earlier draft of `spec/door/api.md` placed `door_cosig` over `{ shard_id, text, door_id, epoch }` directly into soulchain `cosigners`, which conflicts with OSP (`verifyRecord` verifies cosigners over envelope `core` bytes; memory `body` has no `shard_id`). Spec now documents a two-phase flow: **review** (approve/reject; optional `host_audit_sig` not in `cosigners`) then **commit** (`door_cosig` over raw OSP `core`, same as `/door/attest`). `spec/osp/records.md` append-order prose aligned.

**Contract (T2.5 / revisit T3.2):** If the host rejects **all** candidate shards, `Session.depart` still emits the journal file and appends departure + travel, but the journal never lands on-chain (no approved memory record). Quarantine (T3.2) is the natural place to revisit retaining rejected material.

## Residency lifecycle — commit co-signing only in the travel gap (2026-10)

**Problem:** the quarantine lifecycle (`spec/osp/records.md` — candidate, then a co-signed `shard` after the window) needs a Door commit co-signature *after* the window, and `door-sdk` binds commit to the review session so it "may run after departure (quarantine window)". But the reference Door (`door-sdk` `Door`) keeps **one** in-memory cosign review state, bound to the last reviewed epoch, and **clears it on every arrival** (`cosignState = null`; also lost on a Door restart). With a single Door, the Wanderer's next residency is the next arrival at that same Door — so after re-arriving at epoch N+1 the Door answers commits for epoch N with `review_pending`, and a periodic "commit while live" sweep can never succeed. `spec/door/api.md` does not say how long a Door must retain an epoch's review. **Workaround (runtime only, no protocol change):** the daemon's commit sweep (`NPC_QUARANTINE_COMMIT_INTERVAL_MS`, default off) runs in the travel gap — after departure N, before arrival N+1 — and polls until epoch N's candidates ripen and commit; the Wanderer is therefore absent for the whole quarantine window, so config caps `NPC_QUARANTINE_WINDOW_MS` at 1 h while the sweep is on. `commitQuarantinedShards` gained a `residency` scope so stranded candidates of older epochs (sweep off, Door restart, abandoned residency) are ignored instead of failing the sweep. Stranded candidates stay `memory.candidate` forever. **Follow-up (spec + door-sdk + door-discord):** per-epoch review retention that survives later arrivals (bounded, e.g. last K epochs or until the window expires) and Door restarts (durable store), plus normative text in `spec/door/api.md` on retention; then the sweep can run while live and the window can return to 24 h. Also open: a production `wanderer quarantine flag` path through the daemon (it holds the append lock), without which the window is a delay rather than a veto — host review is the veto.

## Residency lifecycle — journal generated from approved shards only (2026-10)

`Session.depart` previously generated the journal from **all** distilled candidates before host review; the journal is published on chain (journal side blob on the first committed shard), so prose the host rejected could leak through the journal's paraphrase. The journal is now generated after review from the host-approved shards only (with zero approved shards it is still written to `journalDir` and never reaches the chain, per the T2.5 contract above). Not a spec change — the spec does not define journal inputs — recorded because it changes depart's order of operations (review before journal).
