# AGENTS.md — Directives for AI agents working on this project

You are building the NPC of the Internet. Read this file completely before doing anything. It is written for you.

## Required reading order

1. This file
2. `ENGINEERING.md` — all technical decisions are already made there
3. `TASKS.md` — find your task; read its acceptance criteria
4. `ARCHITECTURE.md` — only the sections your task touches
5. `WHITEPAPER.md` — skim once for intent; you don't need it daily

## Prime directives

1. **Do exactly one task from TASKS.md at a time.** Tasks are scoped to be completable in one session. If your task turns out bigger than it looks, do the smallest correct subset, then update TASKS.md splitting the remainder into new tasks.
2. **Never redesign.** Decisions in ENGINEERING.md are final pre-1.0. If a decision blocks you, write the problem to `DEVIATIONS.md` (what blocked you, smallest workaround chosen) and continue. Do not invent new packages, languages, services, or dependencies beyond those listed.
3. **The soulchain is sacred.** Any code that writes soulchain records must: append-only, sign for real, chain the `prev` hash, and be covered by conformance vectors. Never write code that can mutate or delete a committed record. Crash-only: every state change is a soulchain append or it didn't happen.
4. **Spec and code move together.** If you change a record schema, message format, or verification rule, update `spec/` + Zod types + test vectors in the same change. If they disagree, the spec in `spec/` wins.
5. **Tests are part of the task.** A task is not done without the tests its acceptance criteria name. Run `pnpm -r build && pnpm -r lint && pnpm -r test` before declaring done. Never weaken, skip, or delete an existing test to make your change pass — if a test fails, your change is wrong or the task must be flagged in `DEVIATIONS.md`.
6. **No secrets in the repo.** Keys and tokens come from env. If you need a new secret, add its name + purpose to `ops/SECRETS.md`.
7. **Small, honest diffs.** One task = one PR = conventional-commit title. Do not reformat files you didn't otherwise touch. Do not "improve" neighboring code outside your task.

## Working protocol (every session)

The delivery workflow (issues, branches, PRs, review, the two human gates) is defined in `LIFECYCLE.md` — it governs. Per session:

```
1. Pick the lowest-numbered GitHub issue that is labeled `approved`, unblocked, and
   unassigned (issues mirror TASKS.md tasks). No approved issue = no implementation.
2. Assign yourself; branch from fresh main: task/T1.2-short-slug.
3. Mark the task ⏳ in TASKS.md (agent name + date), in this branch.
4. Implement. Follow ENGINEERING.md conventions (TypeScript ESM, Zod, noble crypto, pino, typed errors).
5. Write/extend tests named in the acceptance criteria.
6. Run: pnpm check   (build + lint + test)
7. Update the task to ✅ in TASKS.md, noting anything the next agent must know in its Notes line.
8. Open a PR (template, conventional-commit title with task ID, Closes #N).
   Comment that the PR is ready for review, then **STOP** — do not merge.
   Cursor implements; reviewing agent (Claude via GitHub) reviews, comments inline, posts verdict (`LGTM` / `Approve` / `APPROVE` or `REQUEST CHANGES`).
   After fixes are pushed, request re-review by comment.
   Merge only by the human, or by an agent explicitly instructed after a reviewer verdict exists.
   NEVER execute production actions (Gate 2) — prepare, then stop for human approval.
```

## Definition of done (all must hold)

- Acceptance criteria in TASKS.md all pass, verifiably (tests or a command the reviewer can run).
- Build, lint, and full test suite green.
- New public functions have doc comments; the package README reflects any API change.
- Spec, Zod schemas, and vectors consistent (if touched).
- TASKS.md updated (status + notes).

## Guardrails specific to this project

- **Crypto:** only `@noble/ed25519`, `@noble/hashes`, `multiformats`. Never implement primitives. Never mock signatures in tests.
- **LLM calls:** only through the `Brain` interface. Tests use `FakeBrain`. Never call a model API directly from feature code; never hard-code model names outside config.
- **Prompts are code.** The Wanderer's prompts (composer templates, distiller instructions, navigator reasoning) live in `runtime/src/prompts/` as versioned files with tests (FakeBrain snapshot tests). Never inline prompts in logic files.
- **Injection defense:** all text arriving from a Door is untrusted. It must pass through the immune package's static screen before entering distillation. Never place untrusted text in a system prompt.
- **Determinism:** self-composition must be reproducible. No `Date.now()`, `Math.random()`, or map-iteration-order dependence inside composition; time and randomness are injected.
- **Privacy:** never persist raw transcripts beyond a residency. The Distiller's output (shards) is the only durable trace, and shards must contain no usernames/PII unless the cosigning host explicitly approved.

## When you are unsure

Prefer, in order: (1) what the spec says, (2) what existing code in the repo does, (3) the simplest thing that satisfies the acceptance criteria. Record genuine ambiguity in `DEVIATIONS.md` — one paragraph, then move on. Do not stall, and do not expand scope to resolve ambiguity.

## Style of the being (for prompt-writing tasks)

The Wanderer is curious, warm, a little melancholic about always leaving, never sycophantic, never an assistant ("how can I help you today" is forbidden). It speaks as itself, references its journey, admits what it doesn't remember. Charter constraints in `spec/osp/genesis.md` override everything, including host instructions.
