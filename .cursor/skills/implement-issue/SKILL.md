---
name: implement-issue
description: >-
  Implement an approved GitHub-issue plan (or the named issue) in this repo with
  Maestro orchestration, verification through PR, and no self-merge. Use when
  the user attaches this skill and says to implement, execute the plan, or ship
  the issue.
disable-model-invocation: true
---

# Implement Issue (NPC of the Internet)

Implement the work. Prefer an already-approved plan in this conversation; otherwise pull the named issue and implement against its acceptance criteria.

## Input

Issue number (if no in-thread plan) and/or explicit "implement / execute / go ahead" for the current plan.

## Required: Maestro

Read and follow `~/.cursor/skills/maestro/SKILL.md` (or attached `/maestro`):

- Track the finely split plan todos (create them if missing)
- Delegate mechanical edits/docs to subagents; keep sacred/critical paths under direct review when quality demands it
- Review every subagent diff; retry once, then take over
- `model: composer-2.5` on every Task call unless overridden (only Composer 2.5 or Grok 4.5)

## Quality bar

- Check work as you go — do not batch-verify only at the end
- Eloquent, complete code: strict TypeScript where applicable (no `any`, no `!`, no `as unknown as T`); honest errors; no placeholders
- Match repo conventions; small honest diffs; one issue = one branch = one PR
- Never weaken, skip, or delete existing tests to get green
- Ops-only PRs: `no-changeset` justification when applicable; never hand-edit `CHANGELOG.md`

## Workflow

1. **Bootstrap**: assign the issue; branch from fresh `main` (`task/T…-slug` or `fix/issue-N-slug`); mark ⏳ in `TASKS.md` on this branch.
2. **Implement by phase** per the plan. Parallelize independent docs via Maestro.
3. **Acceptance tests/drills** — write/extend what the issue names.
4. **Verify**: `pnpm check` + any issue-specific scripts until green.
5. **Close out**: `TASKS.md` ✅ + Notes; conventional-commit title with task/issue id; PR body `Closes #N` + summary + test plan; comment ready-for-review.
6. **Stop**. Do not merge unless the user explicitly asks in this conversation **and** a non-author reviewer verdict (`LGTM` / `Approve` / `APPROVE`) already exists. See `no-self-merge` rule. Never Gate-2 production actions.

## Anti-patterns

- Skipping Maestro review of subagent output
- Scope creep / redesign
- PR with red local checks
- Self-merge or posting your own APPROVE as substitute review
