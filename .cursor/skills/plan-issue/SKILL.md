---
name: plan-issue
description: >-
  Pull a GitHub issue and produce a detailed Maestro-orchestrated implementation
  plan with finely split todos for this repo. Use when the user attaches this
  skill and names an issue (e.g. "#63", "issue 63"), or asks to plan a GH issue.
disable-model-invocation: true
---

# Plan Issue (NPC of the Internet)

Pull the given GitHub issue and plan the work. Do not implement.

## Input

Issue number required. Examples: `/plan-issue #63`, `/plan-issue 63`. If missing, ask and stop.

## Required: Maestro

Read and follow `~/.cursor/skills/maestro/SKILL.md` (or the attached `/maestro` skill):

- Decompose into small, independently verifiable subtasks
- Delegate research to `explore` / `shell` subagents (`model: composer-2.5` unless overridden; only Composer 2.5 or Grok 4.5 per repo rules)
- Review every subagent output; retry once, then take over
- Never delegate the whole request as one giant subtask

## Repo gates (non-negotiable)

Read in order before planning: `AGENTS.md` → `ENGINEERING.md` → `TASKS.md` → relevant `ARCHITECTURE.md`. Honor `LIFECYCLE.md`:

- Issue must be `approved`, unblocked, and suitable to pick (note if a lower-numbered approved issue exists)
- Never redesign; decisions in ENGINEERING.md are final; blocked → `DEVIATIONS.md`
- Soulchain sacred; spec/code move together; no secrets
- Plan stays within the issue checklist — discovered work becomes a new issue, not scope creep

## Workflow

1. **Fetch** with `gh issue view <N> --json number,title,body,labels,state,assignees,comments,url`.
2. **Explore in parallel** via Maestro: root-cause paths, tests/CI, runbooks/docs, adjacent issues that constrain scope.
3. **Double-check** critical files yourself before trusting subagents.
4. **Lock decisions** — if the issue offers options, pick one concrete approach from evidence; no A/B left open in the plan.
5. **Create the plan** (CreatePlan / plan mode): problem + root cause with paths, chosen design, phased sequence, explicit non-goals.
6. **Todos — methodical and finely split**:
   - One todo = one file change, one behavior, or one assertion — not a phase blob
   - Phases: lifecycle → core fix → tests/drills → docs → verify → PR (ready-for-review, no merge)
   - Prefer 15–30 sharp todos over 5 fat ones
7. **Stop** after presenting the plan. No branch/edit/commit until the user runs `/implement-issue` or explicitly says to execute.

## Anti-patterns

- Implementing during planning
- Fat todos ("harden backup-watch.sh") — split env / helper / each behavior
- Accepting explore claims without opening cited files
- Expanding past the issue checklist
