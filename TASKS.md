# TASKS.md — Full build breakdown

Status legend: ⬜ todo · ⏳ in progress (add agent name + date) · ✅ done
Rules: work strictly by dependency order; one task per session/PR; update status + Notes when done. See AGENTS.md for the working protocol.

Each task lists **Deps**, **Deliverables**, and **Acceptance** (how a reviewer verifies). "Green" always means `pnpm -r build && pnpm -r lint && pnpm -r test` passes.

---

## Phase 0 — Skeleton

### T0.1 ✅ Repo scaffold (Claude, 2026-07-19)
- Deps: none
- Note: **this folder is the repo root** — the existing top-level docs (AGENTS.md, ENGINEERING.md, TASKS.md, WHITEPAPER.md, ARCHITECTURE.md, README.md) stay where they are. Scaffold around them. Start with `git init` + initial commit of the docs, then create the GitHub repo `npc-of-the-internet` and push.
- Deliverables: pnpm workspace root (`pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, ESLint + Prettier config, `.gitignore`, LICENSE (MIT), `.github/workflows/ci.yml` per ENGINEERING.md D4); empty packages `osp-core`, `osp-cli`, `runtime`, `immune`, `door-sdk`, `door-discord`, `atlas` each with `package.json`, `src/index.ts`, one trivial test.
- Acceptance: fresh clone → `pnpm install` → green. CI workflow runs the same steps.
- Notes: Done outside the normal PR flow (initial commit, pre-lifecycle). `pnpm check` verified green (build + lint + 7/7 package tests). Lifecycle docs added in the same commit: LIFECYCLE.md, .cursor/rules/, issue/PR templates. Next agent: start at T0.2 via an approved GitHub issue per LIFECYCLE.md.

### T0.2 ✅ Spec directory + genesis charter (Composer, 2026-07-20)
- Deps: T0.1
- Deliverables: `spec/osp/records.md` (prose schemas for all record types from ARCHITECTURE.md §2), `spec/pop/overview.md` (keys, session keys, attestations, handover — v0.1 scope: single key, manual handover), `spec/door/api.md` (Door endpoints: hello/session/heartbeat/attest/cosign), `spec/osp/genesis.md` (the Wanderer's charter: personality per AGENTS.md "Style of the being", constraints: no PII in shards, spend policy stub, host-instruction override rule).
- Acceptance: docs exist, internally consistent with ARCHITECTURE.md; another agent can implement T1.x from spec alone.
- Notes: Specs at `osp/0.1`, `pop/0.1`, `door/0.1`. Epoch is **global** (Wanderer-owned); Doors do not allocate epochs (`active_epoch` on hello is informational). Attestation `body.kind`: `arrival` | `heartbeat` | `departure` | `travel` (`handover` reserved). Cosigner payload = envelope `core` (omit `cosigners`+`sig`); soul signs after cosigners filled. Door cosigs for attestations via `POST /door/attest`. Keys/sigs base64url; CIDs CIDv1 **base32** (`bagu…`, dag-json codec). Canonical key sort = UTF-16 code unit order. Next: T0.3 or T1.1 (Zod from `records.md`).

### T0.3 ✅ Release tooling (changesets) (Grok 4.5, 2026-07-20)
- Deps: T0.1
- Deliverables: `@changesets/cli` configured (fixed versioning, all packages one version); `.changeset/config.json`; PR template gains a "changeset added (or N/A: docs/tests only)" checkbox; `release.yml` workflow per ENGINEERING.md D7 (tag → Docker images to GHCR + GitHub Release).
- Acceptance: `pnpm changeset` works; a dry-run `changeset version` bumps all packages together and generates CHANGELOG.md entries. Green.
- Notes: Fixed group = all seven `@npc/*` packages. `release.yml` opens Version Packages PRs on main (Gate 2 to merge) and on `v*` tags creates a GitHub Release + GHCR pushes. Dockerfiles expected at `ops/Dockerfile.runtime`, `ops/Dockerfile.door-discord`, `ops/Dockerfile.atlas-api` (T6.1); docker job skips cleanly until those exist. Changesets writes per-package CHANGELOGs; release body reads `packages/osp-core/CHANGELOG.md` as canonical.

## Phase 1 — osp-core (the chain)

### T1.1 ✅ Record types + signing
- Deps: T0.2
- Deliverables: in `osp-core`: Zod schemas for all record types; canonical JSON serialization (sorted keys, no whitespace — document it in spec); Ed25519 sign/verify; CID computation (`multiformats`, sha2-256, dag-json codec); `createRecord`, `verifyRecord`.
- Acceptance: unit tests incl. tamper detection (flip one byte → verify fails); generated JSON Schema emitted to `spec/osp/schema/`. Green.
- Notes: Implemented from `spec/osp/records.md`. CID prefix `bagu` (dag-json) — see DEVIATIONS.md. JSON Schema at `spec/osp/schema/`. Next: T1.2 SoulStore. Agent: Grok 4.5 Maestro, 2026-07-20.

### T1.2 ✅ SoulStore (append-only local store)
- Deps: T1.1
- Deliverables: `SoulStore` interface (`append`, `head`, `get(cid)`, `iterate`); `FileSoulStore` impl: JSONL chain file + blob dir, fsync on append, refuses append if `prev` ≠ current head; corruption detection on open.
- Acceptance: unit tests: append/read/iterate; simulated partial-write recovery; concurrent-append rejection. Green.
- Notes: FileSoulStore: chain.jsonl + blobs/<cid>, fsync, wx lock, open fails on torn line / openWithRecovery truncates. Agent: Grok 4.5 Maestro, 2026-07-20. Next: T1.3 verifyChain + vectors. #19: CID format validation before path.join in FileSoulStore; candidate_cid schema tightened; vector schema-bad-candidate-cid.json.

### T1.3 ✅ Chain verification + test vectors
- Deps: T1.2
- Deliverables: `verifyChain(store)` — full walk: sigs, prev-links, seq monotonicity, schema validity, cosigner sigs where required; vector suite in `spec/osp/vectors/` (≥1 valid chain, ≥6 invalid: bad sig, broken link, seq gap, schema violation, missing cosign, forked head) + vector runner test.
- Acceptance: all vectors pass/fail as labeled. Green.
- Notes: `verifyRecords`/`verifyChain` with structured ChainRule failures; FileSoulStore.loadChain reuses verifyRecords; schema hardening (residency regex, door_id cross-check, key/sig lengths, genesis cosigners:[]); vectors in `spec/osp/vectors/` + generate:vectors; bagu prose + Verification §6 heartbeat aligned. Absorbs #7. Agent: Grok 4.5 Maestro, 2026-07-20. Next: T1.4 osp CLI. #24: `prev` and `drift.evidence` tightened to `CidSchema`; well-formed-but-wrong vector fixture CID; `schema-bad-prev` / `schema-bad-evidence` vectors regenerated.

### T1.4 ✅ osp CLI (Composer 2.5 Maestro, 2026-07-20)
- Deps: T1.3
- Deliverables: `osp` binary in `osp-cli`: `osp init` (genesis from `spec/osp/genesis.md` + new key), `osp verify <dir>`, `osp log <dir>` (human-readable chain listing), `osp show <cid>`.
- Acceptance: README walkthrough: init → verify → log works on a fresh dir; e2e test scripts the same. Green.
- Notes: `osp` bin at `packages/osp-cli/dist/cli.js`; charter auto-resolves in-repo; `soul.key` mode `0o600`; verify maps load-time chain failures to exit 1 and torn-store corruption to exit 2 with `openWithRecovery` guidance. #17 follow-up: `extractTimestamp` key list aligned to spec bodies; `CorruptionError.failures` on chain verify open; e2e exit-code and `--door-key` coverage. Next: T2.1 Brain interface (parallel).

## Phase 2 — Runtime (the being)

### T2.1 ✅ Brain interface + FakeBrain (Composer 2.5 Maestro, 2026-07-20)
- Deps: T0.1
- Deliverables: `Brain` interface in `runtime` (`complete(messages, opts)`); `AnthropicBrain` (config from env per ENGINEERING.md D2); `FakeBrain` (scripted responses for tests); config loader with Zod validation.
- Acceptance: unit tests with FakeBrain; `LIVE_TESTS=1` smoke test file exists (not run in CI). Green.
- Notes: `packages/runtime/src/brain/` — types, FakeBrain, AnthropicBrain, Zod config (`loadBrainConfig`), BrainError. Env: ANTHROPIC_API_KEY, NPC_BRAIN_MODEL, NPC_BRAIN_MAX_TOKENS, NPC_BRAIN_TIMEOUT_MS. Live smoke at `test/live/anthropic-brain.live.test.ts` (skipped unless LIVE_TESTS set). ops/SECRETS.md created. Next: T2.2 Self-Composer.

### T2.2 ✅ Self-Composer (Grok 4.5 Maestro, 2026-07-20)
- Deps: T1.3, T2.1
- Deliverables: `composeSelf(store) → {systemPrompt, memoryIndex}`: genesis charter + drift records + shard retrieval index. Deterministic (injected clock/randomness per AGENTS.md). Prompt templates in `runtime/src/prompts/composer/`.
- Acceptance: golden-file test — same chain head twice → byte-identical output; composing a longer fixture chain includes drift + shards in prompt. Green.
- Notes: `composeSelf(store, options?)` with `ComposeSelfOptions.doorPublicKeys` forwarded to verify only. Single materialize → `verifyRecords` → compose from same snapshot (plus store-head cross-check). Template strategy (a) TS const in `src/prompts/composer/system.ts`. Journal + drift evidence excluded from prompt. Goldens: `pnpm --filter @npc/runtime generate:goldens`. MemorySoulStore at `test/helpers/memory-soul-store.ts` for T2.4. Next: T2.4.

### T2.3 ✅ Distiller (Cursor Grok 4.5 Maestro, 2026-07-21)
- Deps: T2.1, T1.1
- Deliverables: end-of-residency distillation: transcripts → 5–20 candidate shards (first-person, ≤500 chars, PII-stripped) via Brain; transcript destruction after distillation; prompts in `runtime/src/prompts/distiller/`.
- Acceptance: FakeBrain tests: shard count/length limits enforced, PII regex screen applied, transcripts deleted from disk after run. Green.
- Notes: Agent: Cursor Grok 4.5 Maestro, 2026-07-21. `distillTranscripts(source, brain, opts?)` → `CandidateShard[]` (Door cosign shape). Strategy (a) TS prompts in `src/prompts/distiller/`. Built-in PII regex + allowlist with `// T3.1: immune screen hook`; destroy transcripts only after successful validation. No chain/Door writes. Next: T2.5.

### T2.4 ✅ Session loop (Cursor Grok 4.5 Maestro, 2026-07-21)
- Deps: T2.2
- Deliverables: residency session engine: receives Door messages, maintains rolling context, calls Brain, returns signed responses (session-key signature per PoP spec — v0.1: session key = derived subkey, recorded in an `attestation` record at arrival); writes heartbeat attestations on an injected timer.
- Acceptance: integration test with FakeBrain + in-memory Door stub: scripted 20-message residency produces a verifying chain with arrival attestation + heartbeats. Green.
- Notes: Agent: Cursor Grok 4.5 Maestro, 2026-07-21. HKDF-SHA-512 session keys via `deriveSessionKey(doorId, epoch)`; `DoorStub` at `test/helpers/door-stub.ts`; integration test `test/session-integration.test.ts`. Next: T2.3 or T2.5.

### T2.5 ✅ Departure + manual handover (v0.1)
- Deps: T2.3, T2.4
- Deliverables: `depart` flow: distill → submit shards for cosign → append cosigned `memory` records + farewell `attestation`; `arrive` flow for next Door; operator CLI command `wanderer move <door>` orchestrating both; journal generation (markdown summary of residency) appended as part of the memory record body.
- Acceptance: integration test: full reside→depart→arrive across two stub Doors yields one continuous verifying chain; journal file emitted. Green.
- Notes: Agent: Cursor Grok 4.5 Maestro, 2026-07-21. `Session.depart` calls `stop()` + `drainAppends()` before distill → journal → two-phase Door cosign (review then per-shard commit with core-bound `door_cosig`) → cosigned `memory` records → departure + travel attestations. `move()` orchestrates depart + `Session.start` at the next door; `wanderer move <door-id>` CLI bin. Integration test `test/handover-integration.test.ts` (reside→depart→arrive, journal file on disk). Next: T3.1.

## Phase 3 — Immune system (v0.1 scope: static screen)

### T3.1 ✅ Static screen
- Deps: T1.1
- Deliverables: in `immune`: injection-pattern screen (instruction-like text, role markers, URLs-with-payload heuristics) + PII screen (emails, phones, handles) with allowlist hook; applied to inbound Door text and candidate shards; rejections logged with category only.
- Acceptance: unit tests with a labeled corpus (≥30 cases, both classes) in `immune/test/corpus/`; screen wired into Distiller (T2.3 test extended). Green.
- Notes: Agent: Cursor Grok 4.5 Maestro, 2026-07-21. Corpus in immune/test/corpus/ (≥30); Distiller + session inbound use screenText; category names are pii.*/injection.*; DistillError reason screen_reject. Next: T3.2 quarantine.

### T3.2 ✅ Quarantine records
- Deps: T3.1, T2.5
- Deliverables: candidate shards enter chain as `memory.candidate` records; commit to full `memory` only after quarantine window (config duration) with no operator flag; rejected candidates become `memory.rejected` (category only, no payload).
- Acceptance: vectors added for candidate/committed/rejected transitions; integration test drives all three paths. Green.
- Notes: Agent: Cursor Grok 4.5 Maestro, 2026-07-21. Depart appends candidate/rejected; commitQuarantinedShards + flagCandidate + CLI; Door commit bound to review session after departure; vectors quarantine-candidate-to-shard/rejected + schema-rejected-with-payload. Next: T4.2.

## Phase 4 — Door: Discord

### T4.1 ✅ door-sdk
- Deps: T0.2, T1.1
- Deliverables: `door-sdk` implementing the Door API contract from spec: hello/session/heartbeat/attest/cosign as a typed library (in-process transport for tests + ws transport); Door identity keypair + signing.
- Acceptance: contract tests: sdk stub door passes the same integration suite used in T2.4/T2.5. Green.
- Notes: Agent: Cursor Grok 4.5 Maestro, 2026-07-21. Wire Zod schemas + signing in `@npc/door-sdk`; `Door` core + `HostPolicy`; in-process/`node:http`/`ws` transports; `door_cosig` = raw UTF-8 OSP `core` bytes (commit + attest); runtime re-exports types; `DoorStub` thin-wraps SDK. Contract + T2.4/T2.5 suites green. Follow-up: `spec/door/vectors/`. Next: T4.2.

### T4.2 ✅ door-discord
- Deps: T4.1, T2.5
- Deliverables: Discord adapter (discord.js): binds one guild channel to a residency; relays messages both ways; rate limiting; host operator commands (`/wanderer status`, cosign approval flow via reaction or command); config via env.
- Acceptance: integration test against a mocked discord.js client runs a full residency; manual test doc `packages/door-discord/MANUAL_TEST.md` for a real server. Green.
- Notes: Agent: Cursor Grok 4.5 Maestro, 2026-07-21. DiscordGateway seam + ReviewGatedDoor (timeout→rejected); FakeGateway residency integration (post-T3.2 candidates); MANUAL_TEST uses package harness until wanderer CLI Door client lands in T6.1. Next: T6.1 (needs T5.1) or T5.2.

## Phase 5 — Atlas

### T5.1 ✅ Atlas read API
- Deps: T1.3
- Deliverables: Fastify service in `atlas`: `/state` (present/traveling/sleeping + current door), `/chain/head`, `/records?type=&page=`, `/journals`; everything derived by reading the soulchain dir read-only.
- Acceptance: unit tests over a fixture chain; API never writes. Green.
- Notes: `FileSoulStore.openReadOnly` (soft verify/torn tail, no lock); Fastify `/state` `/chain/head` `/records` `/journals` via ChainView cache; fixture `test/fixtures/multi-residency/`. Agent: Cursor Grok 4.5 Maestro, 2026-07-21. Next: T5.2. Issue #36.

### T5.2 ✅ Atlas site
- Deps: T5.1
- Deliverables: Astro static site: home (current location banner), journey timeline, journal pages, soul explorer (record list + detail w/ verification badge); builds from fixture chain in CI; deploy workflow to GitHub Pages (ENGINEERING.md D4).
- Acceptance: `pnpm build` in atlas produces the site from the fixture chain; CI deploy workflow present. Green.
- Notes: Package `@npc/atlas-site` (Astro static, build-time `ChainView`/`derive*` + `verifyRecords`). Default chain: `packages/atlas/test/fixtures/multi-residency/`. Deploy: `.github/workflows/deploy-atlas-site.yml` (enable Pages → GitHub Actions; deploy job soft-fails until then). ENGINEERING D1 tree still lists site under `atlas/` — site lives in `atlas-site` per #47. Agent: Cursor Grok 4.5 Maestro, 2026-07-21. Next: T6.1 (after T4.2) then T6.2.

## Phase 6 — Ship Ghost (v0.1)

### T6.1 ⬜ Ops: compose + backup
- Deps: T4.2, T5.1
- Deliverables: `ops/compose.ghost.yml` (runtime + door-discord + atlas-api), Dockerfiles, soulchain volume + append-triggered backup sidecar (rclone), `ops/SECRETS.md`, `ops/RUNBOOK.md` (start, stop, upgrade-with-verify, restore-from-backup, crash recovery).
- Acceptance: `docker compose -f ops/compose.ghost.yml config` valid; runbook steps executable by an agent with no prior context; restore drill documented + scripted.
- Notes:

### T6.2 ⬜ Genesis ceremony + launch checklist
- Deps: T6.1, T5.2, T3.2
- Deliverables: `ops/LAUNCH.md`: generate soul key, run `osp init` with the real charter, first residency checklist, public announcement template linking Atlas + soulchain head CID; dry-run script that executes the full checklist against a scratch environment.
- Acceptance: dry-run passes end to end; a second agent can follow LAUNCH.md verbatim.
- Notes:

## Phase 7 — Post-Ghost (v0.2/0.3 — spec first, then build)

These are sequenced but intentionally coarser; split them into T-numbered subtasks (same format) when their phase begins.

- **T7.1 ⬜ IPFS SoulStore** (helia impl of SoulStore; pinning strategy) — Deps: T6.2
- **T7.2 ⬜ door-web** (embeddable widget, client-side signature verification, PRESENT/ELSEWHERE state) — Deps: T6.2
- **T7.3 ⬜ PoP v0.2** (real session-key rotation, handover ceremony records, conflict-proof format + Atlas violation log) — Deps: T7.2
- **T7.4 ⬜ Verifier ensemble** (k-model immune screening per ARCHITECTURE.md §5, escalation, public rejection log) — Deps: T7.1 — Note from T3.1 (#40): add measurable corpus fixtures for known static-screen FPs (benign docs URLs with "instructions", casual "system prompt" discussion) before tightening `URL_INSTRUCTION_PATTERN` / instruction heuristics.
- **T7.5 ⬜ Invitations + Navigator selection** (signed invitations, weighting, drand randomness, pre-committed decision records) — Deps: T7.3
- **T7.6 ⬜ Chain anchoring** (Anchor interface impl on an L2; `osp verify` checks anchors) — Deps: T7.1
- **T7.7 ⬜ Treasury + wallet** (custody per ENGINEERING.md D5 evolution, spend policy from charter, public transaction records, sleep mode) — Deps: T7.6
- **T7.8 ⬜ Drift + the Vigil** (drift record rules: cite ≥N shards; contest flow) — Deps: T7.4
- **T7.9 ⬜ Threshold soul key** (t-of-n custody behind Keyring interface) — Deps: T7.3
- **T7.10 ⬜ Spec freeze → extract OpenSoul as standalone project** (spec/ + osp-core + osp-cli + vectors → `opensoul` repo via git filter-repo; triggers and rules in ENGINEERING.md D1) — Deps: T7.5, T7.8, T7.9

---

## Critical path to launch

T0.1 → T0.2 → T1.1 → T1.2 → T1.3 → T2.2 → T2.4 → T2.5 → T3.2 → T4.1 → T4.2 → T6.1 → T6.2
(T1.4, T2.1, T2.3, T3.1, T5.x can proceed in parallel where deps allow.)
