# @npc/runtime

## 0.5.0

### Minor Changes

- 9af61b4: Per-epoch cosign review state: quarantined shards of a past epoch can now be committed while a later residency is live, so the commit sweep runs on a timer during normal residency with the default 24 h quarantine window.

  **door-sdk** — `Door` no longer clears its cosign review state on arrival. Completed reviews are retained per epoch (bounded by the new `cosignRetention` option: last 16 epochs / 7 days by default) and a commit for a retained past epoch is accepted while a newer residency is live, authenticated by that epoch's review session key; all binding rules (residency `door:<id>/epoch:<reviewed epoch>`, approved text, single-use per `seq`, idempotent identical-core retry) are unchanged. Reviews for a past epoch are `epoch_closed`. A commit for an unretained past epoch returns the new `review_not_retained` (410). New optional `cosignStateStore` (`FileCosignStateStore`: atomic write + fsync; approved text only) persists retained reviews across restarts; a failed save returns `internal_error` and no co-signature. New capability `cosign.past_epochs` (additive door/0.1, lockstep upgrade). `isCosignReviewCompleted` (protected) now takes the epoch. New exports: `FileCosignStateStore`, `CosignStateStore`, `PersistedCosignStateSchema`, `COSIGN_STATE_FILE`, `CosignRetention`, `DEFAULT_COSIGN_RETAIN_EPOCHS`, `DEFAULT_COSIGN_RETAIN_MS`, `CosignCommitResponseSchema`; `Door.getRetainedReviewEpochs()`.

  **door-discord** — advertises `cosign.past_epochs`; new env `DOOR_STATE_DIR` (persist review state; Ghost compose mounts a `door-state` volume at `/data/door-state`), `DOOR_COSIGN_RETAIN_EPOCHS`, `DOOR_COSIGN_RETAIN_MS`.

  **runtime** — `commitQuarantinedShards` signs each commit for the candidate's own epoch (session key re-derived from the soul key) instead of one `epoch` option (removed), ignores candidates of other Doors, adds `journalFor` / `skipCids` options and reports `strandedCids` (`review_not_retained`). With a Door advertising `cosign.past_epochs`, the daemon re-arrives right after departure and commits ripe past-epoch candidates on `NPC_QUARANTINE_COMMIT_INTERVAL_MS` while live (serialized with heartbeat appends; journals read back from `NPC_JOURNAL_DIR`). The config-time `NPC_QUARANTINE_WINDOW_MS ≤ 1 h` refusal is gone; against a legacy Door the daemon keeps the travel-gap sweep and refuses to boot (after `hello`, before any append) with a window over 1 h. New: `Session.withAppendLock`, `LiveResidency.pastEpochCommits` / `withAppendLock`, `ResidencyControllerOptions.commitPending`, `ResidencyDaemonDeps.clock`.

- b0f5c3f: Residency lifecycle in the production daemon (reside → distill → publish → move). A new `ResidencyController` owns the live residency and runs a cycle: close the session socket (travel-gap inbound is dropped, never queued) → `Session.depart` (distill the live transcript, host cosign review, candidate/rejected records, journal to `NPC_JOURNAL_DIR`, departure + travel) → optional commit sweep of the departed epoch → re-arrival at the same Door under `epoch + 1` with a new session socket. Depart failures retry, then abandon crash-style so the Wanderer is never stranded; re-arrival retries with backoff; single-flight; SIGTERM aborts cleanly.

  All triggers default **off**: `NPC_RESIDENCY_OPERATOR_TRIGGER` (SIGUSR2 or the new `wanderer depart` command, which drops a request into `NPC_CONTROL_DIR`), `NPC_RESIDENCY_MAX_MS` timer (≥ 1 h, waits for `NPC_RESIDENCY_MIN_LINES`), and `NPC_QUARANTINE_COMMIT_INTERVAL_MS` commit sweep (runs in the travel gap because the Door forgets an epoch's review on the next arrival; requires `NPC_QUARANTINE_WINDOW_MS` ≤ 1 h). SIGUSR2 is now always handled, so a stray signal no longer terminates the daemon.

  `Session.depart` now writes the journal after host review from approved shards only, so rejected prose cannot reach the published journal. `commitQuarantinedShards` accepts a `residency` scope. New exports: `ResidencyController`, `loadResidencyConfig`, control-dir helpers; `ResidencyDaemonHandle` gains `requestCycle()` / `currentEpoch()`.

### Patch Changes

- 2d0d30f: Round-2 runtime/Door review fixes (2026-10):

  - Door cosign: `issued_at` freshness is checked once, on receipt; `ReviewGatedDoor` finishes a review via `cosignReceivedFresh` (session/epoch/signature re-verified, clock not), so a host review longer than the 5-minute skew window no longer fails `timestamp_stale` after the shards were posted.
  - Review retries are matched by `(epoch, session_pubkey, {shard_id, text} set)` instead of the request signature: a re-signed retry joins the in-flight review, and after completion gets the stored signed response instead of `epoch_closed`. A different shard set is still `review_pending` / `epoch_closed`.
  - Commit: a retry at the same `seq` with a byte-identical `core` returns the stored co-signature (idempotent) instead of `shard_not_approved`; the runtime reuses the core it prepared for a chain position (same `distilled_at`/journal refs) when retrying.
  - `HttpDoorConnection`: explicit cosign-review timeout (`DEFAULT_COSIGN_REVIEW_TIMEOUT_MS`, 290 s, option `cosignReviewTimeoutMs`); door-discord `DISCORD_REVIEW_TIMEOUT_MS` default lowered to 240 s.
  - Attention: reasoning tags inside the decision's JSON object (`{"say":"try <think> tags"}`) are content, not reasoning, and no longer erase the answer.
  - Room log: display names keep their real text (NFKC + invisible/control stripping, grapheme-safe truncation, ZWJ kept inside emoji/complex-script sequences); the immune screen's lossy normalizer is used only for the `YOU` impersonation check.

- e2023c8: Runtime review fixes (2026-10):

  - Attention prompt: untrusted room text is substituted with a single-pass replacer function, so `` $` ``, `$'`, `$&` and `$$` in a message can no longer expand into a forged left-edge room-log entry. The distiller retry prompt uses a replacer function too.
  - Attention decisions: `<think>…</think>` (and similar) reasoning is stripped before parsing; the last balanced top-level JSON object that matches the decision shape wins; unparseable output is only spoken when it is plain prose with no `{` and no reasoning marker, so reasoning or broken JSON is never sent to the room.
  - Depart waits for an in-flight inbound decision, and `observe` / `handleInbound` drop a Brain result that lands after `stop()` (no transcript record, no signed outbound).
  - Replication drain: `stop()` awaits the tick that is actually running (concurrent ticks join it); CAR uploads abort after a configurable timeout (`DEFAULT_CAR_UPLOAD_TIMEOUT_MS`, 120 s).
  - Room log: display names are NFKC-normalized, stripped of control/format/line-separator characters, and can never render as `YOU` (`YOU.`, `ＹＯＵ`, `Y O U`, …); continuation lines are indented after every Unicode line break.
  - Selective attention keeps observed entries (and their `addressed` flag) in the pending batch even when a burst evicts them from the bounded room log mid-decision.
  - Distill measures shard length in UTF-16 units (what the Door's `CandidateShardSchema` enforces), so emoji-heavy shards no longer abort departure.
  - Daemon: a boot failure after the store opens releases the WS client, session timer, replication drain and store; shutdown runs every step even if one throws.

- Updated dependencies [9af61b4]
- Updated dependencies [b36d936]
- Updated dependencies [17be3cb]
- Updated dependencies [e9b9e45]
- Updated dependencies [2d0d30f]
  - @npc/door-sdk@0.5.0
  - @npc/immune@0.5.0
  - @npc/osp-core@0.5.0

## 0.4.3

### Patch Changes

- 234730c: Ops-only (ships the backup image): the backup sidecar treated rclone's empty `lsjson` result on bucket remotes (B2/S3 print `[` and `]` on separate lines with exit 0 when the object is missing) as unparseable, so with no remote `chain.jsonl` it refused every chain upload — blobs were backed up but the chain tip never was. Empty multi-line arrays now count as size 0. The budget test's rclone shim now mimics bucket-remote `lsjson` semantics, and fails against the old script.
  - @npc/osp-core@0.4.3
  - @npc/immune@0.4.3
  - @npc/door-sdk@0.4.3

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
