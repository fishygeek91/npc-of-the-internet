# @npc/door-sdk

## 0.6.0

### Minor Changes

- 4fcc330: Witnessed memory and travel between Doors (`door/0.2`). The Wanderer now lives at one Door at a time and moves on about once a day to a random Door that is online, never staying put while somewhere else is open. Its second Door is new: `@npc/door-web`, a public web porch that is open while the Wanderer is there and otherwise says where it went. No human approves memories any more, and there is no quarantine. At departure the Door where a memory formed co-signs it only after its independent AI witness has checked the memory against the Door's own record of what happened there. Witnessed memories are final as soon as they are appended. A memory the witness declines is kept only as a `rejected` record that gives the reason, never the text. Each residency's journal is written from witnessed memories only and is witnessed too (new osp/0.2 `journal` memory kind). Older `candidate` records still verify. On Discord, the review reactions are gone, and the bot posts when the Wanderer arrives and when it leaves.

  **Upgrade:** the runtime and both Doors must run the same release, because `door/0.2` is strict. Add `,web:home=<door pubkey>` to `ATLAS_DOOR_PUBKEYS`, using the same key as the Discord Door. The witness reuses the `NPC_BRAIN_*` settings when `NPC_BRAIN_PROVIDER=openai-compat`. The old `DISCORD_REVIEW_*`, `DOOR_COSIGN_RETAIN_*` and `NPC_QUARANTINE_*` settings no longer do anything. The daily move and the operator `depart` trigger are now on by default — delete any `NPC_RESIDENCY_OPERATOR_TRIGGER=0` / `NPC_RESIDENCY_MAX_MS=0` lines copied from an older `.env.example`, or they keep the Wanderer in place.

### Patch Changes

- Updated dependencies [4fcc330]
  - @npc/osp-core@0.6.0

## 0.5.0

### Minor Changes

- 9af61b4: Per-epoch cosign review state: quarantined shards of a past epoch can now be committed while a later residency is live, so the commit sweep runs on a timer during normal residency with the default 24 h quarantine window.

  **door-sdk** — `Door` no longer clears its cosign review state on arrival. Completed reviews are retained per epoch (bounded by the new `cosignRetention` option: last 16 epochs / 7 days by default) and a commit for a retained past epoch is accepted while a newer residency is live, authenticated by that epoch's review session key; all binding rules (residency `door:<id>/epoch:<reviewed epoch>`, approved text, single-use per `seq`, idempotent identical-core retry) are unchanged. Reviews for a past epoch are `epoch_closed`. A commit for an unretained past epoch returns the new `review_not_retained` (410). New optional `cosignStateStore` (`FileCosignStateStore`: atomic write + fsync; approved text only) persists retained reviews across restarts; a failed save returns `internal_error` and no co-signature. New capability `cosign.past_epochs` (additive door/0.1, lockstep upgrade). `isCosignReviewCompleted` (protected) now takes the epoch. New exports: `FileCosignStateStore`, `CosignStateStore`, `PersistedCosignStateSchema`, `COSIGN_STATE_FILE`, `CosignRetention`, `DEFAULT_COSIGN_RETAIN_EPOCHS`, `DEFAULT_COSIGN_RETAIN_MS`, `CosignCommitResponseSchema`; `Door.getRetainedReviewEpochs()`.

  **door-discord** — advertises `cosign.past_epochs`; new env `DOOR_STATE_DIR` (persist review state; Ghost compose mounts a `door-state` volume at `/data/door-state`), `DOOR_COSIGN_RETAIN_EPOCHS`, `DOOR_COSIGN_RETAIN_MS`.

  **runtime** — `commitQuarantinedShards` signs each commit for the candidate's own epoch (session key re-derived from the soul key) instead of one `epoch` option (removed), ignores candidates of other Doors, adds `journalFor` / `skipCids` options and reports `strandedCids` (`review_not_retained`). With a Door advertising `cosign.past_epochs`, the daemon re-arrives right after departure and commits ripe past-epoch candidates on `NPC_QUARANTINE_COMMIT_INTERVAL_MS` while live (serialized with heartbeat appends; journals read back from `NPC_JOURNAL_DIR`). The config-time `NPC_QUARANTINE_WINDOW_MS ≤ 1 h` refusal is gone; against a legacy Door the daemon keeps the travel-gap sweep and refuses to boot (after `hello`, before any append) with a window over 1 h. New: `Session.withAppendLock`, `LiveResidency.pastEpochCommits` / `withAppendLock`, `ResidencyControllerOptions.commitPending`, `ResidencyDaemonDeps.clock`.

### Patch Changes

- b36d936: Door review fixes (2026-10): WS session server no longer crashes on long close reasons, unmasked/oversized frames (short fixed close reasons, per-socket error listeners, 256 KiB `maxPayload`); attest/commit co-signatures are bound to the request (attestation kind + residency; reviewed shard text via `text_hash`, single-use per chain position); outbound frames are replay- and freshness-checked (`msg_replay`); keycap reactions restricted to `[0-9#*]`. Discord: no mention pings (`allowedMentions` everywhere), 2000-char chunking, `failIfNotExists: false` replies, per-epoch bounded msg-id map, cosign review freshness checked before posting and duplicate reviews joined/rejected, gateway dispatch errors caught and logged.
- 2d0d30f: Round-2 runtime/Door review fixes (2026-10):

  - Door cosign: `issued_at` freshness is checked once, on receipt; `ReviewGatedDoor` finishes a review via `cosignReceivedFresh` (session/epoch/signature re-verified, clock not), so a host review longer than the 5-minute skew window no longer fails `timestamp_stale` after the shards were posted.
  - Review retries are matched by `(epoch, session_pubkey, {shard_id, text} set)` instead of the request signature: a re-signed retry joins the in-flight review, and after completion gets the stored signed response instead of `epoch_closed`. A different shard set is still `review_pending` / `epoch_closed`.
  - Commit: a retry at the same `seq` with a byte-identical `core` returns the stored co-signature (idempotent) instead of `shard_not_approved`; the runtime reuses the core it prepared for a chain position (same `distilled_at`/journal refs) when retrying.
  - `HttpDoorConnection`: explicit cosign-review timeout (`DEFAULT_COSIGN_REVIEW_TIMEOUT_MS`, 290 s, option `cosignReviewTimeoutMs`); door-discord `DISCORD_REVIEW_TIMEOUT_MS` default lowered to 240 s.
  - Attention: reasoning tags inside the decision's JSON object (`{"say":"try <think> tags"}`) are content, not reasoning, and no longer erase the answer.
  - Room log: display names keep their real text (NFKC + invisible/control stripping, grapheme-safe truncation, ZWJ kept inside emoji/complex-script sequences); the immune screen's lossy normalizer is used only for the `YOU` impersonation check.

- Updated dependencies [e9b9e45]
  - @npc/osp-core@0.5.0

## 0.4.3

### Patch Changes

- @npc/osp-core@0.4.3

## 0.4.2

### Patch Changes

- @npc/osp-core@0.4.2

## 0.4.1

### Patch Changes

- @npc/osp-core@0.4.1

## 0.4.0

### Minor Changes

- 617cc56: Selective attention, reactions, and live residency transcript.

  - door-sdk: additive door/0.1 capabilities `session.reactions` (outbound `reaction: { emoji, target_msg_id }`, text-less reaction frames) and `session.addressing` (inbound `addressed`). Spec updated in `spec/door/api.md`.
  - runtime: `Session.observe` — the Wanderer reads a room log and decides to speak, react, both, or stay silent (one Brain call per burst, deterministic floor guard). `NPC_ATTENTION_MODE=selective|always` (default `selective`). New `ResidencyTranscript` records observed + spoken lines in memory for `depart()` distillation (WHITEPAPER §3.2).
  - door-discord: advertises both capabilities; addressed detection (@mention / reply to the Wanderer), msg_id ↔ Discord id mapping for threaded replies and reactions, typing indicator, and screen-safe mention rendering (raw `@name` would trip the immune `pii.handle` screen).

  Deploy the runtime and door-discord images together: a pre-release runtime rejects a `hello` that lists the new capability values.

### Patch Changes

- @npc/osp-core@0.4.0

## 0.3.2

### Patch Changes

- @npc/osp-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [3d55b11]
  - @npc/osp-core@0.3.1

## 0.3.0

### Patch Changes

- @npc/osp-core@0.3.0

## 0.2.2

### Patch Changes

- @npc/osp-core@0.2.2

## 0.2.1

### Patch Changes

- @npc/osp-core@0.2.1

## 0.2.0

### Patch Changes

- d8d7e36: Verify cosign session binding and signatures before Discord review-gate posts (fixes unauthenticated attacker text in host channel, #65).
- 019ff29: Harden Door protocol: arrival epoch replay/supersession + issued_at skew, HTTP body size cap (413), client verifies Door response signatures, WS closes on depart/supersede (#66).
- Updated dependencies [6a5d6ac]
- Updated dependencies [3f36562]
- Updated dependencies [5782dc6]
- Updated dependencies [2c7f13a]
- Updated dependencies [eb91666]
- Updated dependencies [b9b96f6]
- Updated dependencies [cb20020]
- Updated dependencies [403982e]
- Updated dependencies [de4ec18]
  - @npc/osp-core@0.2.0

## 0.1.0

### Minor Changes

- 73f2d38: Add OSP record types, canonical JSON, Ed25519 signing, and CID helpers in osp-core (T1.1).
- 10d8f2d: Add append-only FileSoulStore (JSONL + blobs, fsync, locks) behind SoulStore interface (T1.2).
- 402210a: Add verifyChain/verifyRecords, schema hardening, and OSP conformance vectors (T1.3).
- fccf82b: Add osp CLI binary with init, verify, log, and show commands (T1.4).
- 846ad84: Add Brain interface, AnthropicBrain, FakeBrain, and Zod config loader (T2.1).
- 949de8d: Quarantine lifecycle: candidate → shard/rejected with deferred Door commit (T3.2).
- 57b101c: Door API contract library: Zod schemas, signing helpers, Door core with HostPolicy, in-process/HTTP/ws transports; runtime re-exports wire types and DoorStub wraps SDK Door (T4.1).

### Patch Changes

- a732224: HttpDoorConnection and WsDoorSessionClient for networked Door Session transport.
- f5353f6: Coalesce Door WebSocket session onto the HTTP listener for Ghost compose.
- Updated dependencies [e4adc27]
- Updated dependencies [1eececa]
- Updated dependencies [73f2d38]
- Updated dependencies [10d8f2d]
- Updated dependencies [402210a]
- Updated dependencies [e59d2e7]
- Updated dependencies [fccf82b]
- Updated dependencies [846ad84]
- Updated dependencies [949de8d]
- Updated dependencies [e51ae2e]
  - @npc/osp-core@0.1.0
