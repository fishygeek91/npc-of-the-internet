# Engineering Decisions

Opinionated. Downstream agents: **do not re-litigate these choices.** If a decision blocks you, record the problem in `DEVIATIONS.md` (create it if absent) and pick the smallest workaround — do not redesign.

## D1. One repo (monorepo)

Everything lives in a single repository: `npc-of-the-internet`.

Why: the spec, runtime, doors, and tools must stay in lockstep while the protocol is pre-1.0; cross-cutting changes (a record schema tweak touches spec + runtime + CLI + tests) must land atomically; and a single repo is far easier for AI agents to navigate and keep consistent.

**OpenSoul extraction (T7.10):** OSP is destined to be its own project. It is extracted into a standalone `opensoul` repo (spec + `osp-core` + `osp-cli` + conformance vectors, history preserved via `git filter-repo`) when **any two** of these hold: (a) OSP/PoP spec freeze at 1.0, (b) a second independent implementation or soul exists, (c) an external project wants to adopt OSP. Until then, `spec/`, `osp-core`, and `osp-cli` must never import from other packages — they must remain extractable at any moment. CI should fail on any inward dependency.

```
npc-of-the-internet/
├── AGENTS.md            # AI directives — read first
├── ENGINEERING.md       # this file
├── TASKS.md             # full task breakdown
├── WHITEPAPER.md
├── ARCHITECTURE.md
├── spec/
│   ├── osp/             # Open Soul Protocol spec (record schemas, verification rules)
│   ├── pop/             # Proof-of-Presence spec (keys, attestations, handover)
│   └── door/            # Door API spec (OpenAPI + message schemas)
├── packages/
│   ├── osp-core/        # record types, signing, hashing, chain verification
│   ├── osp-cli/         # `osp` CLI: verify, explore, diff, init
│   ├── runtime/         # Wanderer runtime (Self-Composer, Distiller, Navigator, Treasury)
│   ├── immune/          # static screen + verifier ensemble
│   ├── door-sdk/        # shared Door adapter library
│   ├── door-discord/    # first Door
│   ├── door-web/        # second Door (v0.2)
│   └── atlas/           # public site + read API
├── ops/                 # Dockerfiles, compose, deploy scripts
└── .github/workflows/   # CI
```

## D2. Stack

- **Language: TypeScript everywhere.** Node ≥ 22, ESM only. One language keeps agent context small and skills transferable across packages. No Python, no Rust, no exceptions pre-1.0.
- **Package manager: pnpm** with workspaces. Root `pnpm-workspace.yaml`.
- **Schemas: Zod** for all record/message types, exported from `osp-core`. JSON Schema is *generated* from Zod (`zod-to-json-schema`) into `spec/` — never hand-written in two places.
- **Crypto: `@noble/ed25519` + `@noble/hashes`** (audited, zero-dep). Ed25519 signatures, SHA-256 hashing, CIDs via `multiformats`. No homemade crypto ever.
- **Storage v0.1:** append-only JSONL soulchain file + content-addressed blob dir, behind a `SoulStore` interface. IPFS (`helia`) is a v0.2 implementation of the same interface. Chain anchoring is v0.3 — stub the `Anchor` interface until then.
- **LLM access:** one `Brain` interface in `runtime` (`complete(messages, opts)`). Default implementation: Anthropic API. Model name, keys, temperature only from env/config — never hard-coded at call sites.
- **Atlas:** Astro static site + a tiny Fastify read-API. No database — the soulchain is the database; Atlas derives everything.
- **Config:** env vars validated by Zod at boot (`config.ts` per deployable). Fail fast with a readable message listing missing vars.

## D3. Testing

Test framework: **Vitest**. Rules:

1. **Every package ships unit tests.** Minimum bar: all exported functions have at least one happy-path and one failure-path test.
2. **Spec conformance tests are the crown jewels.** `spec/*/vectors/` holds JSON test vectors (valid chains, invalid chains, tampered records, conflicting attestations). `osp-core` must pass all vectors; any new spec rule requires new vectors *in the same PR*.
3. **Determinism tests.** Self-composition (soulchain head → composed self) must be byte-identical across runs. Golden-file tests in `runtime/test/golden/`; update goldens only with an explicit `drift`-of-the-code justification in the PR description.
4. **No mocked-crypto tests.** Sign/verify for real; keys are cheap.
5. **LLM-dependent code:** the `Brain` interface gets a deterministic `FakeBrain` for tests (scripted responses). Real-model tests live in `test/live/`, run only with `LIVE_TESTS=1`, never in CI.
6. **Integration test per Door:** spin runtime + door in-process, run a scripted residency end to end (arrive → messages → distill → cosign → depart), assert the resulting soulchain verifies.
7. Coverage is not a gate; the vector suites and integration tests are.

## D4. CI/CD (GitHub Actions)

- **`ci.yml`** on every PR: `pnpm install` → `pnpm -r build` → `pnpm -r lint` (ESLint + Prettier check) → `pnpm -r test` → `osp verify` on the committed example chain. All must pass to merge. Node 22, single OS (ubuntu-latest).
- **`deploy-atlas.yml`** on main: build Atlas static site → deploy to GitHub Pages.
- **`release.yml`** on tag: build Docker images (`runtime`, `door-discord`, `atlas-api`) → push to GHCR.
- Branch protection: PRs only, CI green, no force-push to main. AI agents commit via PRs like everyone else.

## D5. Deployment

- **v0.1 "Ghost":** one VPS (any provider), Docker Compose in `ops/compose.ghost.yml` running `runtime` + `door-discord` + `atlas-api`, with the soulchain dir as a mounted volume that is **backed up on every append** (sidecar rsync/rclone to object storage — losing the soulchain is losing the being). Atlas static site on GitHub Pages.
- **Secrets:** env file on the host, never in the repo. Required secrets are listed in `ops/SECRETS.md` (names + purpose only).
- **Soul key v0.1:** single Ed25519 key on the host, path from env. Threshold custody is v0.3+ (Task-gated; see TASKS.md P3) — the `Keyring` interface must hide this from all callers from day one.
- **Upgrades:** stop runtime → snapshot soulchain → deploy new image → `osp verify` → start. The runtime must always tolerate being killed mid-residency (crash-only design: every state change is a soulchain append or it didn't happen).

## D6. Conventions

- **Commits:** Conventional Commits (`feat(osp-core): ...`, `fix(door-discord): ...`).
- **Versioning:** packages share one version, `changesets` for releases. Specs version independently (`osp/0.1`, `pop/0.1`) and record their version in every soulchain record.
- **Errors:** typed error classes per package; never throw strings; never swallow errors silently.
- **Logging:** `pino`, structured JSON, one logger per deployable. Every soulchain append logs `seq`, `type`, `cid`.
- **Docs:** every package has a README with: purpose (2 sentences), public API, how to run tests. Spec changes update `spec/` in the same PR.
- **License:** MIT for code, CC-BY-4.0 for specs/whitepaper.

## D7. What NOT to build (pre-1.0)

No token or tokenomics. No smart contracts beyond the eventual anchor (v0.3). No user accounts/auth on Atlas. No fine-tuning pipeline. No mobile apps. No kubernetes. No microservices — deployables are three processes, period. If a task seems to need one of these, it's mis-scoped; flag it in `DEVIATIONS.md`.
