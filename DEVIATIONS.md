# DEVIATIONS.md

Smallest workarounds when ENGINEERING.md or spec prose blocks implementation. One paragraph per entry; link the task if applicable.

## T1.1 — CID base32 prefix (`bafy` vs `bagu`) — **resolved**

**Resolved (T1.3):** `spec/osp/records.md` and TASKS.md now use `bagu…` examples consistent with dag-json + sha2-256. Implementation was already correct.

## T2.5 — `/door/cosign` shard co-signer payload — **resolved (spec)**

**Resolved (T2.5):** An earlier draft of `spec/door/api.md` placed `door_cosig` over `{ shard_id, text, door_id, epoch }` directly into soulchain `cosigners`, which conflicts with OSP (`verifyRecord` verifies cosigners over envelope `core` bytes; memory `body` has no `shard_id`). Spec now documents a two-phase flow: **review** (approve/reject; optional `host_audit_sig` not in `cosigners`) then **commit** (`door_cosig` over raw OSP `core`, same as `/door/attest`). `spec/osp/records.md` append-order prose aligned.

**Contract (T2.5 / revisit T3.2):** If the host rejects **all** candidate shards, `Session.depart` still emits the journal file and appends departure + travel, but the journal never lands on-chain (no approved memory record). Quarantine (T3.2) is the natural place to revisit retaining rejected material.

**Superseded (door/0.2, 2026-10-06):** `/door/cosign` is gone; memories are witnessed one by one through `/door/attest` (`kind: "memory"`), declined ones become `rejected` records, and the journal is witnessed like a shard (see "Witnessed memory" below).

## Residency lifecycle — commit co-signing only in the travel gap (2026-10) — **resolved**

**Was:** the reference Door kept one in-memory cosign review state, bound to the last reviewed epoch and cleared on every arrival (and lost on restart), so the daemon's commit sweep had to run in the travel gap and config capped `NPC_QUARANTINE_WINDOW_MS` at 1 h while the sweep was on. **Resolved (spec + door-sdk + door-discord + runtime):** `spec/door/api.md` now defines **Review retention** behind the additive `door/0.1` capability `cosign.past_epochs`: a Door keeps completed reviews per epoch across later arrivals (door-sdk: last 16 epochs / 7 days, configurable), optionally durable (`FileCosignStateStore`; door-discord `DOOR_STATE_DIR`, a `door-state` volume in Ghost compose), and accepts commits for a retained past epoch authenticated by that epoch's session key with every binding rule unchanged; an unretained past epoch answers `review_not_retained` (410). The runtime re-derives the past epoch's session key from the soul key (no extra secret retained) and, against such a Door, runs the commit sweep on a timer during live residency with the default 24 h window; against a legacy Door it keeps the travel-gap sweep and refuses (at boot, after `hello`, before any append) a window over 1 h. Still open: a production `wanderer quarantine flag` path through the daemon (it holds the append lock) — until then the window is a delay rather than a veto; host review is the veto.

**Superseded (door/0.2, 2026-10-06):** review retention, the quarantine window, the commit sweep and `NPC_QUARANTINE_*` are removed. Witnessed memories are final when appended, so no flag path is needed.

## Residency lifecycle — journal generated from approved shards only (2026-10)

`Session.depart` previously generated the journal from **all** distilled candidates before host review; the journal is published on chain (journal side blob on the first committed shard), so prose the host rejected could leak through the journal's paraphrase. The journal is now generated after review from the host-approved shards only (with zero approved shards it is still written to `journalDir` and never reaches the chain, per the T2.5 contract above). Not a spec change — the spec does not define journal inputs — recorded because it changes depart's order of operations (review before journal).

**Carried into door/0.2:** the journal is now written from the **witnessed** shards only, and is itself witnessed as an osp/0.2 `journal` memory record (`spec/osp/records.md`); with zero witnessed shards no journal is written to the chain.

## Witnessed memory (door/0.2, 2026-10-06) — the Door witness calls a model directly

AGENTS.md / ENGINEERING.md D2 say LLM calls go only through the runtime's `Brain` interface. The memory witness runs **inside the Door**, and `@npc/door-sdk` cannot depend on `@npc/runtime` (Doors are separate deployables; the dependency would pull the runtime and immune graph into every Door image). Smallest workaround: `createAiWitness({ complete })` takes an injectable `CompleteFn` (`{ system, user } → Promise<string>`); the reference `openAiCompatComplete` calls an OpenAI-compatible chat-completions endpoint with native `fetch` (no SDK). Model name, base URL and key come only from config (`loadWitnessConfig`: `DOOR_WITNESS_*`, falling back to `NPC_BRAIN_*` when `NPC_BRAIN_PROVIDER=openai-compat`; `DOOR_WITNESS=off` disables). Tests use fake `CompleteFn`s, never the network. Following "prompts are code", the witness rubric lives in `packages/door-sdk/src/prompts/witness.ts`, not in `runtime/src/prompts/`. Revisit if `Brain` ever moves to a package Doors may depend on.

## Witnessed memory — genesis charter still mentions host approval at cosign time

`spec/osp/genesis.md` ("no PII in shards … unless the cosigning host has explicitly approved"; "say so plainly at cosign time") describes the door/0.1 host-review flow, which no longer exists. The text is kept **verbatim**: the live chain's genesis record embeds the charter, and composition reads it from the chain, so editing the file would make it disagree with the soul it describes. In practice the rule is now stricter than the charter's wording: there is no approval step, and the Door's witness declines any memory with private details about identifiable people (`witness_private`). A charter amendment, if ever wanted, belongs to the drift/Vigil process (T7.8), not a file edit.

## Witnessed memory — legacy memory forms kept verify-only

Chains written under door/0.1 may hold `memory` records of kind `candidate`, and shards with an embedded `journal_cid`. door/0.2 runtimes never write either form, but `osp-core` keeps accepting them when verifying (and the Atlas still renders them) so existing soulchains stay valid; `spec/osp/records.md` §Legacy memory forms. They can be dropped at spec freeze (T7.10) together with any other pre-1.0 legacy. The production chain had zero memory records when door/0.2 shipped (checked 2026-10-06), so no migration was run.

## Deployables — more than three processes

ENGINEERING.md D8 says deployables are three processes. Ghost compose now runs `runtime`, `door-discord`, `door-web` and `atlas-api` (plus the backup sidecar, and Caddy under the optional `public` profile). This follows D1, which already lists `door-web` as the second Door: a Door is one process per platform, not a new service tier. No microservices, databases or queues were added.
