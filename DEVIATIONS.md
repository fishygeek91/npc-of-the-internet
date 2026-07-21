# DEVIATIONS.md

Smallest workarounds when ENGINEERING.md or spec prose blocks implementation. One paragraph per entry; link the task if applicable.

## T1.1 — CID base32 prefix (`bafy` vs `bagu`) — **resolved**

**Resolved (T1.3):** `spec/osp/records.md` and TASKS.md now use `bagu…` examples consistent with dag-json + sha2-256. Implementation was already correct.

## T2.5 — `/door/cosign` shard co-signer payload — **resolved (spec)**

**Resolved (T2.5):** An earlier draft of `spec/door/api.md` placed `door_cosig` over `{ shard_id, text, door_id, epoch }` directly into soulchain `cosigners`, which conflicts with OSP (`verifyRecord` verifies cosigners over envelope `core` bytes; memory `body` has no `shard_id`). Spec now documents a two-phase flow: **review** (approve/reject; optional `host_audit_sig` not in `cosigners`) then **commit** (`door_cosig` over raw OSP `core`, same as `/door/attest`). `spec/osp/records.md` append-order prose aligned.
