# Development Lifecycle

AI end to end, with exactly **two human gates**: approval to begin work, and approval to go to production. Implementation and review are done by agents; **merge** is performed by the human (or by an agent explicitly instructed by the human after a reviewer verdict).

## The loop

```
TASKS.md task ──► GitHub issue ──► [HUMAN GATE 1: `approved` label]
     ──► branch ──► implementation ──► PR ──► [author stops] ──► AI review ──► [human merge]
     ──► ... ──► release candidate ──► [HUMAN GATE 2: production approval] ──► deploy/launch
```

### 1. Intake

Every unit of work is a GitHub issue created from the **Task** issue template, referencing its TASKS.md ID (e.g. `[T1.2] SoulStore`). Agents may create issues for any unblocked TASKS.md task, and must file discovered work (bugs, follow-ups) as new issues rather than expanding scope.

### 2. Human gate 1 — approval to begin

No agent starts implementation until a human adds the **`approved`** label to the issue. Unlabeled issues are backlog. An agent asked to "pick up work" selects the lowest-numbered approved, unblocked, unassigned issue.

### 3. Branch

One issue = one branch = one PR. Branch naming: `task/T1.2-soulstore`, `fix/issue-42-short-slug`. Never commit directly to `main` (branch protection enforces this). Keep branches short-lived; rebase on `main` before opening the PR.

### 4. Implementation

Per AGENTS.md prime directives and ENGINEERING.md decisions. Before opening a PR: `pnpm check` (build + lint + test) must be green locally, TASKS.md status updated in the same branch.

### 5. Pull request

Use the PR template. Title is a conventional commit (it becomes the squash commit): `feat(osp-core): append-only SoulStore (T1.2)`. Body links the issue (`Closes #N`). PRs must be small — one task. If a PR grows past ~600 changed lines excluding lockfiles/goldens, split it.

### 6. AI review

Every PR gets a review from an AI agent **that did not author it** (typically Claude via the GitHub connector).

**Mechanics:** because all agents authenticate as the repo owner, GitHub blocks formal reviews (approve / request-changes) on these PRs. AI reviews are therefore posted as **PR comments** (often titled `🤖 AI Review — APPROVE` or `🤖 AI Review — REQUEST CHANGES`) and are binding: a PR must not be merged until a reviewer comment contains an explicit verdict — `LGTM`, `Approve`, or `APPROVE` (including the emoji title form above). This is a procedural gate, not a GitHub-enforced one. The reviewer checks, in order: acceptance criteria met and verifiable · soulchain/crypto guardrails (AGENTS.md) respected · spec/schemas/vectors moved together · tests real (no weakened or skipped tests) · scope matches the issue. Reviewer either approves or requests changes with specific, actionable comments. Authors respond by pushing fixes, not by arguing scope. **After opening a PR, the author must STOP** — see §7.

### 7. Merge

After opening a PR, **STOP**. Do not merge. Comment that the PR is ready for review, then end the session.

Merging happens only after a reviewer comment containing an explicit verdict (`LGTM` / `Approve` / `APPROVE`, including title `🤖 AI Review — APPROVE`) exists, AND is performed by the **human** or an agent **explicitly instructed by the human**.

Squash-merge + delete branch when: CI green + reviewer verdict + no unresolved threads.

### 8. Human gate 2 — production

Anything that touches the live being or the public requires explicit human approval in the release issue before executing: deploying the runtime/doors to the VPS, the genesis ceremony (LAUNCH.md), key generation/rotation, treasury/wallet operations, tagged releases and published Docker images, and Atlas going live at a public URL. Agents prepare everything (release notes, runbook steps, dry-run results) and stop; a human replies "approved" on the release issue, then agents execute.

## Labels

`task` · `bug` · `approved` (human gate 1) · `blocked` (waiting on dependency; name it in a comment) · `release` (gate-2 issues) · `deviation` (logged in DEVIATIONS.md, needs eventual human read).

## Roles

- **Builder** (Cursor): implement, open PRs, comment ready-for-review, **stop**, respond to review with fixes; never self-merge.
- **Reviewer** (Claude via GitHub): reviews, inline comments, posts verdict; does **not** auto-merge.
- **Human**: Gate 1, Gate 2 production, and **merge** (or explicitly instruct an agent to merge after LGTM).

## Failure handling

CI red on `main` is a stop-the-line event: an agent files a `bug` issue (auto-approved class — no gate needed for fixing a broken main) and the fix PR takes priority over all task work. A PR that can't satisfy its acceptance criteria gets closed with a comment explaining why, the issue relabeled `blocked`, and the blocker filed as its own issue.
