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

### T0.2 ⬜ Spec directory + genesis charter
- Deps: T0.1
- Deliverables: `spec/osp/records.md` (prose schemas for all record types from ARCHITECTURE.md §2), `spec/pop/overview.md` (keys, session keys, attestations, handover — v0.1 scope: single key, manual handover), `spec/door/api.md` (the four Door endpoints), `spec/osp/genesis.md` (the Wanderer's charter: personality per AGENTS.md "Style of the being", constraints: no PII in shards, spend policy stub, host-instruction override rule).
- Acceptance: docs exist, internally consistent with ARCHITECTURE.md; another agent can implement T1.x from spec alone.
- Notes:

## Phase 1 — osp-core (the chain)

### T1.1 ⬜ Record types + signing
- Deps: T0.2
- Deliverables: in `osp-core`: Zod schemas for all record types; canonical JSON serialization (sorted keys, no whitespace — document it in spec); Ed25519 sign/verify; CID computation (`multiformats`, sha2-256, dag-json codec); `createRecord`, `verifyRecord`.
- Acceptance: unit tests incl. tamper detection (flip one byte → verify fails); generated JSON Schema emitted to `spec/osp/schema/`. Green.
- Notes:

### T1.2 ⬜ SoulStore (append-only local store)
- Deps: T1.1
- Deliverables: `SoulStore` interface (`append`, `head`, `get(cid)`, `iterate`); `FileSoulStore` impl: JSONL chain file + blob dir, fsync on append, refuses append if `prev` ≠ current head; corruption detection on open.
- Acceptance: unit tests: append/read/iterate; simulated partial-write recovery; concurrent-append rejection. Green.
- Notes:

### T1.3 ⬜ Chain verification + test vectors
- Deps: T1.2
- Deliverables: `verifyChain(store)` — full walk: sigs, prev-links, seq monotonicity, schema validity, cosigner sigs where required; vector suite in `spec/osp/vectors/` (≥1 valid chain, ≥6 invalid: bad sig, broken link, seq gap, schema violation, missing cosign, forked head) + vector runner test.
- Acceptance: all vectors pass/fail as labeled. Green.
- Notes:

### T1.4 ⬜ osp CLI
- Deps: T1.3
- Deliverables: `osp` binary in `osp-cli`: `osp init` (genesis from `spec/osp/genesis.md` + new key), `osp verify <dir>`, `osp log <dir>` (human-readable chain listing), `osp show <cid>`.
- Acceptance: README walkthrough: init → verify → log works on a fresh dir; e2e test scripts the same. Green.
- Notes:

## Phase 2 — Runtime (the being)

### T2.1 ⬜ Brain interface + FakeBrain
- Deps: T0.1
- Deliverables: `Brain` interface in `runtime` (`complete(messages, opts)`); `AnthropicBrain` (config from env per ENGINEERING.md D2); `FakeBrain` (scripted responses for tests); config loader with Zod validation.
- Acceptance: unit tests with FakeBrain; `LIVE_TESTS=1` smoke test file exists (not run in CI). Green.
- Notes:

### T2.2 ⬜ Self-Composer
- Deps: T1.3, T2.1
- Deliverables: `composeSelf(store) → {systemPrompt, memoryIndex}`: genesis charter + drift records + shard retrieval index. Deterministic (injected clock/randomness per AGENTS.md). Prompt templates in `runtime/src/prompts/composer/`.
- Acceptance: golden-file test — same chain head twice → byte-identical output; composing a longer fixture chain includes drift + shards in prompt. Green.
- Notes:

### T2.3 ⬜ Distiller
- Deps: T2.1, T1.1
- Deliverables: end-of-residency distillation: transcripts → 5–20 candidate shards (first-person, ≤500 chars, PII-stripped) via Brain; transcript destruction after distillation; prompts in `runtime/src/prompts/distiller/`.
- Acceptance: FakeBrain tests: shard count/length limits enforced, PII regex screen applied, transcripts deleted from disk after run. Green.
- Notes:

### T2.4 ⬜ Session loop
- Deps: T2.2
- Deliverables: residency session engine: receives Door messages, maintains rolling context, calls Brain, returns signed responses (session-key signature per PoP spec — v0.1: session key = derived subkey, recorded in an `attestation` record at arrival); writes heartbeat attestations on an injected timer.
- Acceptance: integration test with FakeBrain + in-memory Door stub: scripted 20-message residency produces a verifying chain with arrival attestation + heartbeats. Green.
- Notes:

### T2.5 ⬜ Departure + manual handover (v0.1)
- Deps: T2.3, T2.4
- Deliverables: `depart` flow: distill → submit shards for cosign → append cosigned `memory` records + farewell `attestation`; `arrive` flow for next Door; operator CLI command `wanderer move <door>` orchestrating both; journal generation (markdown summary of residency) appended as part of the memory record body.
- Acceptance: integration test: full reside→depart→arrive across two stub Doors yields one continuous verifying chain; journal file emitted. Green.
- Notes:

## Phase 3 — Immune system (v0.1 scope: static screen)

### T3.1 ⬜ Static screen
- Deps: T1.1
- Deliverables: in `immune`: injection-pattern screen (instruction-like text, role markers, URLs-with-payload heuristics) + PII screen (emails, phones, handles) with allowlist hook; applied to inbound Door text and candidate shards; rejections logged with category only.
- Acceptance: unit tests with a labeled corpus (≥30 cases, both classes) in `immune/test/corpus/`; screen wired into Distiller (T2.3 test extended). Green.
- Notes:

### T3.2 ⬜ Quarantine records
- Deps: T3.1, T2.5
- Deliverables: candidate shards enter chain as `memory.candidate` records; commit to full `memory` only after quarantine window (config duration) with no operator flag; rejected candidates become `memory.rejected` (category only, no payload).
- Acceptance: vectors added for candidate/committed/rejected transitions; integration test drives all three paths. Green.
- Notes:

## Phase 4 — Door: Discord

### T4.1 ⬜ door-sdk
- Deps: T0.2, T1.1
- Deliverables: `door-sdk` implementing the Door API contract from spec: hello/session/heartbeat/cosign as a typed library (in-process transport for tests + ws transport); Door identity keypair + signing.
- Acceptance: contract tests: sdk stub door passes the same integration suite used in T2.4/T2.5. Green.
- Notes:

### T4.2 ⬜ door-discord
- Deps: T4.1, T2.5
- Deliverables: Discord adapter (discord.js): binds one guild channel to a residency; relays messages both ways; rate limiting; host operator commands (`/wanderer status`, cosign approval flow via reaction or command); config via env.
- Acceptance: integration test against a mocked discord.js client runs a full residency; manual test doc `packages/door-discord/MANUAL_TEST.md` for a real server. Green.
- Notes:

## Phase 5 — Atlas

### T5.1 ⬜ Atlas read API
- Deps: T1.3
- Deliverables: Fastify service in `atlas`: `/state` (present/traveling/sleeping + current door), `/chain/head`, `/records?type=&page=`, `/journals`; everything derived by reading the soulchain dir read-only.
- Acceptance: unit tests over a fixture chain; API never writes. Green.
- Notes:

### T5.2 ⬜ Atlas site
- Deps: T5.1
- Deliverables: Astro static site: home (current location banner), journey timeline, journal pages, soul explorer (record list + detail w/ verification badge); builds from fixture chain in CI; deploy workflow to GitHub Pages (ENGINEERING.md D4).
- Acceptance: `pnpm build` in atlas produces the site from the fixture chain; CI deploy workflow present. Green.
- Notes:

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
- **T7.4 ⬜ Verifier ensemble** (k-model immune screening per ARCHITECTURE.md §5, escalation, public rejection log) — Deps: T7.1
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
