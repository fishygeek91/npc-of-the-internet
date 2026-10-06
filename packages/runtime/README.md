# @npc/runtime

The Wanderer runtime: Self-Composer, Distiller, Navigator, Treasury, session loop.

## Brain (T2.1 / T7.11)

All LLM access goes through the provider-agnostic `Brain` interface. `complete` returns `{ text, usage }` (token counts; zeros if the provider omits them).

```ts
import { createBrain, FakeBrain, loadBrainConfig } from "@npc/runtime";

const config = loadBrainConfig();
const brain = createBrain(config);
const { text, usage } = await brain.complete([
  { role: "system", content: "You are the Wanderer." },
  { role: "user", content: "Where are you?" },
]);
```

`FakeBrain` provides deterministic scripted responses for unit tests. `createBrain` refuses `NPC_BRAIN_PROVIDER=fake` (tests construct `FakeBrain` directly).

### Environment variables

`NPC_BRAIN_PROVIDER` selects the implementation (`anthropic` when unset, `openai-compat`, or `fake`).

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NPC_BRAIN_PROVIDER` | no | `anthropic` | `anthropic` \| `openai-compat` \| `fake` |
| `ANTHROPIC_API_KEY` | anthropic* | — | Anthropic API key (direct) |
| `ANTHROPIC_API_KEY_FILE` | anthropic* | — | Path to file containing the Anthropic API key |
| `NPC_BRAIN_API_KEY` | openai-compat* | — | OpenAI-compat API key (direct) |
| `NPC_BRAIN_API_KEY_FILE` | openai-compat* | — | Path to file containing the openai-compat API key |
| `NPC_BRAIN_BASE_URL` | openai-compat | — | OpenAI-compat API origin (e.g. OpenRouter) |
| `NPC_BRAIN_PROVIDER_ALLOWLIST` | OpenRouter | — | Comma-separated provider slugs (`provider.only`) |
| `NPC_BRAIN_MODEL` | openai-compat; optional for anthropic | Anthropic: `claude-sonnet-4-20250514` | Model id (no openai-compat code default) |
| `NPC_BRAIN_MAX_TOKENS` | no | `1024` | Default max output tokens |
| `NPC_BRAIN_TIMEOUT_MS` | no | `60000` | Request timeout (ms) |

\* Set exactly one of `NAME` or `NAME_FILE` (non-empty) for the active provider.

Temperature is omitted from openai-compat requests unless `CompleteOptions.temperature` is set (provider default; OpenAI-compatible APIs typically use 1.0).

See `ops/SECRETS.md` for the canonical secret registry and OpenRouter account hardening.

### Tested openai-compat base URLs

OpenRouter is the **recommended** Ghost path (`https://openrouter.ai/api/v1`). The same `OpenAICompatBrain` also speaks:

- DeepSeek first-party (`https://api.deepseek.com`)
- Gemini OpenAI-compat (`https://generativelanguage.googleapis.com/v1beta/openai`)
- Groq (`https://api.groq.com/openai/v1`)
- DeepInfra (`https://api.deepinfra.com/v1/openai`)

The `provider.only` allowlist is sent only when the base URL host is `openrouter.ai`.

### Live tests

Real-model smoke tests live under `test/live/` and are **skipped by default**. Run locally with:

```bash
LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-... pnpm --filter @npc/runtime test
LIVE_TESTS=1 NPC_BRAIN_PROVIDER=openai-compat NPC_BRAIN_BASE_URL=https://openrouter.ai/api/v1 \
  NPC_BRAIN_API_KEY=sk-... NPC_BRAIN_MODEL=deepseek/deepseek-v4-flash \
  NPC_BRAIN_PROVIDER_ALLOWLIST=fireworks,together,deepinfra \
  pnpm --filter @npc/runtime test
```

CI never sets `LIVE_TESTS`; only unit tests with `FakeBrain`, injected mock clients, and a stub HTTP server run in CI.

## Self-Composer (T2.2)

Deterministic projection of a verified soulchain into a `systemPrompt` and `memoryIndex` for the Wanderer's session brain.

```ts
import { composeSelf, type ComposedSelf, type ComposeSelfOptions } from "@npc/runtime";

const composed: ComposedSelf = await composeSelf(store, {
  doorPublicKeys: { "discord:guild123": doorPublicKey }, // required when chain has cosigned records
});
```

`doorPublicKeys` are verification-only; they must not affect prompt or index content.

**Composes in:** genesis charter, drift summaries (seq order), shard texts (seq order).

**Does not compose:** journal, rejected, legacy candidate, attestation/decision/transaction/sleep records; shard `journal`; drift `evidence` CIDs.

Prompt template lives at `src/prompts/composer/system.ts` (TS string constant, strategy a).

Golden files can be regenerated with:

```bash
pnpm --filter @npc/runtime generate:goldens
```

For integration tests, `test/helpers/memory-soul-store.ts` provides an in-memory `SoulStore` (reused by T2.4).

## Distiller (T2.3)

End-of-residency distillation: transcript lines → 1–20 first-person candidate memory shards (fewer for short stays) via `Brain`. `Session.depart` then asks the Door to witness each one.

```ts
import {
  distillTranscripts,
  FileTranscriptSource,
  FakeBrain,
  type CandidateShard,
} from "@npc/runtime";

const source = new FileTranscriptSource("/tmp/residency-transcript.jsonl");
const brain = new FakeBrain(() =>
  JSON.stringify({
    shards: [
      { text: "I remember feeling curious about the stars." },
      // ... up to 19 more
    ],
  })
);

const shards: CandidateShard[] = await distillTranscripts(source, brain, {
  onScreenReject: (category) => {
    /* category only — never log shard text */
  },
});
```

`FileTranscriptSource` reads newline-delimited JSON; each line is `{ role: "user" | "assistant", text: string, author_id?: string }`. After a successful read, the source is destroyed whether distillation succeeds or fails (privacy). `MemoryTranscriptSource` replays cached in-memory lines when `Session.depart` retries after the on-disk transcript is gone.

Prompt templates live at `src/prompts/distiller/` (TS string constants, strategy a).

**Behavior:** each transcript line passes through `@npc/immune` `screenText` before the Brain call — failing lines are dropped and `onScreenReject` is notified (category only, never payload text); Zod-parse Brain JSON (`{ shards: [{ text, tags? }] }`); one malformed-output retry; empty or over-length shards dropped (≤500 UTF-16 code units, i.e. `String.length` — never more than the spec's 500 code points; reject, not truncate); repeated texts dropped (first wins); output shards are screened again with optional PII allowlist; no surviving shard is `DistillError` `"too_few_shards"` or `"screen_reject"` (with `categories`, never payload text) — `Session.depart` treats both as "no memories"; the transcript source is destroyed after a successful read (success or failure) so raw transcripts do not linger on disk.

**Out of scope:** soulchain append (`Session.depart` witnesses and appends; see [Departure](#departure-witnessed-memory)).

## Session loop (T2.4)

The residency session engine receives Door messages, maintains rolling brain context, signs outbound replies with a derived session key, and appends arrival/heartbeat attestations to the soulchain.

```ts
import {
  Session,
  SingleKeyKeyring,
  FakeBrain,
  type SessionOptions,
} from "@npc/runtime";
```

### `Session.start` options

| Option | Required | Default | Purpose |
|--------|----------|---------|---------|
| `store` | yes | — | Append-only `SoulStore` (genesis head required) |
| `brain` | yes | — | `Brain` for replies |
| `door` | yes | — | `DoorConnection` (`attest`, `heartbeat`) |
| `keyring` | yes | — | `Keyring` — soul signing + session-key derivation |
| `doorId` | yes | — | Door identifier (e.g. `discord:g`) |
| `timer` | yes | — | Injectable `Timer` for heartbeat scheduling |
| `clock` | yes | — | Injectable `Clock` for deterministic timestamps |
| `heartbeatIntervalMs` | no | `600000` | Heartbeat period |
| `maxHistoryMessages` | no | `40` | Rolling brain context cap |
| `doorPublicKeys` | no | — | Passed to `composeSelf` / chain verify when cosigners present |
| `onScreenReject` | no | — | Category-only callback when inbound text fails `@npc/immune` `screenText` (never receives payload text) |
| `activeEpoch` | no | — | Optional floor from Door `hello.active_epoch`; after a mid-arrival crash, epoch allocation uses `max(chain_derived, activeEpoch + 1)` |
| `onHeartbeatError` | no | — | Optional callback when heartbeat attestation fails at `door` or `append` stage |
| `transcript` | no | — | Live in-memory `ResidencyTranscript` (WHITEPAPER §3.2): records screened inbound + spoken replies; `depart()` distills it when no `transcript` is passed |
| `witnessesMemories` | no | `false` | The Door advertised `attest.memory` in `hello`; without it `depart()` forms no memories |
| `attention` | no | see below | `Partial<AttentionPolicy>` for `observe()` — `reactions` (Door has `session.reactions`), `maxSelfShare` (`0.3`), `shareWindow` (`9`), optional `maxTokens` |

`Session.start` composes self from the verified chain, derives a session key via HKDF-SHA-512 (`deriveSessionKey(doorId, epoch)`), appends an arrival attestation, and arms the heartbeat timer. Inbound frames are handled with `handleInbound` (serialized per session — one in-flight Brain call); call `drainAppends()` in tests to await async chain writes. Call `stop()` to end the residency. Before departure (T2.5), call `stop()` then `await drainAppends()` so no heartbeat attestation races the departure record — `Session.depart` does this automatically.

Inbound Door text is screened through `@npc/immune` `screenText` before any Brain call. On failure, `handleInbound` returns `{ ok: false, screened: true, categories }` — no outbound reply, no history update, no chain write; the session stays live. Optional `onScreenReject(category, "session.inbound")` logs category hits only.

### Selective attention — `Session.observe`

`handleInbound` is the legacy door/0.1 loop: one Brain call and one reply per inbound message. `observe(frame)` lets the Wanderer **read the room** instead:

- Every screened message enters a bounded room log (`RoomLog`, never persisted) with a local `#n` ref, speaker label (`YOU` for its own lines), `↩ #n` reply arrows, and an `[ADDRESSED]` marker (Door `addressed` flag, a reply to one of its messages, or its name in the text).
- The Brain gets the composed self + `prompts/attention/system.ts` and the rendered log, and answers `{"say", "reply_to", "react"}` JSON. Speak, react (`session.reactions`), both, or stay silent.
- **Coalescing:** messages that arrive while a decision is in flight are folded into the next one — a burst of chatter costs one Brain call and yields at most one frame (`kind: "coalesced"` for the folded calls).
- **Floor guard (code, not prompt):** if not addressed and the Wanderer already said ≥ `maxSelfShare` of the last `shareWindow` messages, speech is dropped (reactions still allowed).
- Unparseable Brain output → silence, unless the batch addressed the Wanderer and the output is plain prose (spoken as-is).
- Results: `acted` (signed `outbound`, may be text-less with a `reaction`), `silent`, `coalesced`, `screened`, `error`. `reply_to` / `reaction.target_msg_id` are protocol `msg_id`s; the Door maps them to platform ids.

### Live residency transcript

`ResidencyTranscript` (bounded: 1500 lines / 120k chars, oldest dropped) is the in-memory transcript the daemon passes to `Session.start`. Both `observe` and `handleInbound` record screened inbound lines (`role: "user"`, `author_id`) and spoken replies (`role: "assistant"`); reactions are not recorded. `depart()` without a `transcript` option distills from it, then destroys it. It is never written to disk; a process restart loses it (privacy over durability).

### Keyring boundary

`Session` never touches raw soul private keys. Attestation soul-signatures and record sealing go through `Keyring.signWithSoulKey`; outbound frames and heartbeat/attest requests use `Keyring.deriveSessionKey(doorId, epoch)` (returns a `SessionSigner`). Production loads the soul key via `loadSoulPrivateKeyFromPath`; tests use `SingleKeyKeyring`.

### PoP test vectors

Regenerate HKDF session-key derivation vectors:

```bash
pnpm --filter @npc/runtime generate:pop-vectors
```

Vectors live under `spec/pop/vectors/`; the runner is `test/pop-vectors.test.ts`.

### Door stub (integration tests)

`test/helpers/door-stub.ts` is a thin wrapper around `@npc/door-sdk` `Door` (real signatures and core binding; `DoorError`s propagate) with a `ScriptedWitness` (witness / decline with a reason / `"unavailable"`, recording every input; `witness: null` = no `attest.memory`). `test/helpers/test-doors.ts` serves real Doors over HTTP + WebSocket for daemon tests. See `test/session-integration.test.ts` for the full 20-message residency acceptance test.

## Departure (witnessed memory)

No human approves memories. At departure the Door's AI **witness** checks each memory against the Door's own record of the stay and co-signs it; a witnessed memory is final immediately (`spec/door/api.md` §Memory witnessing, `spec/osp/records.md` §memory).

### `Session.depart({ journalDir, toDoorId?, minMemoryLines?, transcript?, brain? })`

Enters `departing` immediately (`stop()` + `drainAppends()`, then waits for any in-flight inbound decision; a late Brain reply is dropped, never recorded or signed). All records use this residency (`door:<id>/epoch:<n>`, `osp/0.2`), in spec order:

1. Read the transcript once and destroy it (cached in-process for retries).
2. No memories (no distill call) when the Door did not advertise `attest.memory` (`witnessesMemories`) or the stay has fewer than `minMemoryLines` lines (default `10`). Otherwise distill (cached); one `rejected` record per immune-screen category.
3. For each shard: compute the side blob (CID + hash) **without storing it**, build the memory core `{kind: "shard", text_cid, text_hash, distilled_at}` and `attest` it as `kind: "memory"` with the `text` (session-signed; `core` binds the text by hash). Witnessed → store the blob, append the shard with the Door co-signature. `witness_declined` → append `rejected` `witness_<reason>` — declined prose never reaches the store.
4. With ≥ 1 witnessed shard: generate the journal from the **witnessed** shard texts only and witness it the same way (`{kind: "journal", journal_cid, journal_hash, written_at}`). Witnessed → store + append, then write it to `journalDir`. Declined → `rejected` `witness_<reason>`, no file.
5. `departure` (Door co-signed) and soul-signed `travel` (`to_door_id`).

Returns `{ witnessed, declined, screened, journalPath }` (counts for the whole residency; `journalPath` is `null` without a witnessed journal).

**Retry:** any other error — `witness_unavailable`, network, Brain, store — throws and leaves the session `departing`; call `depart` again. One in-process **depart ledger** keeps the transcript, the distill output, the Door's verdict per shard text and for the journal, and every sealed record (memory, departure, travel) — each verdict is recorded before its append. A retry never re-asks the Brain or the Door about anything decided: it re-appends the sealed record (a record already at the chain head is an append that landed, and counts as done). A witnessed side blob is stored only immediately before its record's append; declined prose is never stored. A sealed departure is re-appended, never re-attested (the Door already closed the epoch). Retry is **in-process only**: a crash mid-depart loses the transcript by design.

### `Session.departBare(toDoorId?)`

Departure + travel without memories (destroys the transcript; reuses the ledger's sealed records). The controller's best-effort fallback after `depart` kept failing, or after the Door lost the session. When the departure cannot be attested or appended (e.g. `epoch_closed`, `session_invalid`), travel is still appended — soul-signed, `verifyChain` accepts it. Resolves `{ departure }` (whether the departure is on chain); throws only when travel cannot be appended.

### Operator CLI

```bash
wanderer depart [--control-dir <dir>] [--timeout-ms <ms>]
```

Asks the running daemon to travel now (see [Residency lifecycle](#residency-lifecycle)) by dropping a request into `NPC_CONTROL_DIR` (default `/tmp/npc-control`) and waiting for pick-up — exit `0` accepted, `1` not picked up (request withdrawn), `2` usage. In Ghost: `ghostc exec runtime node dist/cli.js depart`. Bin at `packages/runtime/src/cli.ts` (`wanderer` in package `bin`).

### Journal

Markdown account of the residency, generated via Brain from the witnessed shards only (`src/prompts/journal/`), witnessed as a `journal` memory record (side blob), and written to `NPC_JOURNAL_DIR` as `journal-<door>-epoch-<n>.md`. Never composed into the self.

## Test

```bash
pnpm --filter @npc/runtime test
```

## Residency daemon (`npc-runtime`)

Long-running process that opens the soulchain, probes the configured Doors, arrives at one, binds the session WebSocket, and maintains inbound → outbound handling until SIGTERM/SIGINT. About once a day it travels to another online Door (see [Residency lifecycle](#residency-lifecycle)).

```bash
pnpm --filter @npc/runtime build
node packages/runtime/dist/daemon.js
```

Or after install: `npc-runtime` (bin in `@npc/runtime`). Ghost image `CMD` is `node dist/daemon.js` — `pnpm deploy` does not create an `npc-runtime` shim in the image.

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SOUL_KEY_PATH` | yes | — | Path to soul private key file (32 raw bytes or base64url) |
| `SOULCHAIN_DIR` | yes | — | Append-only soulchain directory |
| `NPC_DOOR_URLS` | yes* | — | Comma-separated Door base URLs (`http://door-discord:8787,http://door-web:8788`); WebSocket URL = `http`→`ws`, `https`→`wss` |
| `DOOR_HTTP_HOST` / `DOOR_HTTP_PORT` | yes* | — | Legacy single Door (`http://host:port`) when `NPC_DOOR_URLS` is unset |
| `ATLAS_DOOR_PUBKEYS` | yes | — | Comma-separated `doorId=base64url` — the trusted Doors. A Door whose `hello` `door_id` is not listed, or whose `door_pubkey` differs, is rejected (`door_rejected`) and treated as unavailable |
| `CURRENT_DOOR_ID` | no | — | Boot preference only, used when the chain's last Door (travel destination or arrival) is not online |
| `ANTHROPIC_API_KEY` | anthropic† | — | Anthropic API key (direct; see Brain section) |
| `ANTHROPIC_API_KEY_FILE` | anthropic† | — | Path to file containing the Anthropic API key |
| `NPC_BRAIN_PROVIDER` | no | `anthropic` | `anthropic` \| `openai-compat` \| `fake` |
| `NPC_BRAIN_API_KEY` | openai-compat† | — | OpenAI-compat API key (direct) |
| `NPC_BRAIN_API_KEY_FILE` | openai-compat† | — | Path to file containing the openai-compat API key |
| `NPC_BRAIN_BASE_URL` | openai-compat | — | OpenAI-compat API origin |
| `NPC_BRAIN_PROVIDER_ALLOWLIST` | OpenRouter | — | Comma-separated OpenRouter provider slugs |
| `NPC_BRAIN_MODEL` | openai-compat; optional for anthropic | Anthropic: `claude-sonnet-4-20250514` | Model id |
| `NPC_BRAIN_MAX_TOKENS` | no | `1024` | Default max output tokens |
| `NPC_BRAIN_TIMEOUT_MS` | no | `60000` | Request timeout (ms) |
| `NPC_RUNTIME_READY_FILE` | no | `/tmp/npc-runtime.ready` | Compose healthcheck path (present only while the session WS is connected) |
| `NPC_ATTENTION_MODE` | no | `selective` | `selective`: `Session.observe` (speak / react / stay quiet); `always`: legacy reply-to-every-message |
| `NPC_RESIDENCY_MAX_MS` | no | `86400000` | Travel once the residency is older than this (checked every minute); `0` disables, else ≥ `3600000` |
| `NPC_RESIDENCY_MIN_LINES` | no | `10` | Memory threshold: a timer departure after fewer transcript lines forms no memories (it still travels). Operator departures need one line |
| `NPC_RESIDENCY_OPERATOR_TRIGGER` | no | on | `0`/`false` disables SIGUSR2 and `wanderer depart` |
| `NPC_CONTROL_DIR` | no | `/tmp/npc-control` | Polled for `wanderer depart` requests |
| `NPC_JOURNAL_DIR` | no | `/data/published/journals` | Where depart writes witnessed journals |

\* `NPC_DOOR_URLS`, or the legacy `DOOR_HTTP_HOST` + `DOOR_HTTP_PORT` pair.
† Set exactly one of `NAME` or `NAME_FILE` for the active Brain provider (see Brain section).

Boot logs one `residency_lifecycle_config` line (`doors`, `maxResidencyMs`, `minLines`, `operatorTrigger`, `journalDir`). Selective-mode logs (info): `attention_config` per arrival (mode, reactions, whether the Door witnesses memories), then `attention_acted` (`spoke`, `reacted`, `batchSize`, `notes`) or `attention_silent` (`batchSize`, `notes` e.g. `floor_guard`) per decision. Silence is expected and is not an error.

Graceful shutdown (SIGTERM/SIGINT): remove ready file → stop control-dir polling → `ResidencyController.shutdown()` (abort any cycle wait, give an in-flight cycle step ≤ 5 s, then close WS → `session.stop()` → `drainAppends()`; never departs) → stop replication drain → `store.close()` → exit 0. Each step runs even if an earlier one throws (the first error is rethrown after all steps). A fatal boot failure after the store is opened releases what was acquired before rethrowing.

## Residency lifecycle

The Wanderer is in **one place at a time** and **travels** between Doors. The daemon runs **reside → depart → travel** through a `ResidencyController` (`src/residency/controller.ts`) that owns the live residency (Session + its session WebSocket). Ops guide: [`ops/RUNBOOK.md` §7](../../ops/RUNBOOK.md#7-residency-lifecycle).

```ts
import { ResidencyController, probeDoors, type LiveResidency, type CycleOutcome } from "@npc/runtime";
```

**Doors.** One base URL per Door. `probeDoors` sends `hello` to all of them in parallel (10 s timeout each) and keeps the ones that answer with a verified `hello` whose `door_id` / `door_pubkey` match `ATLAS_DOOR_PUBKEYS`. Each arrival does its own `hello` on a fresh connection, so the Door identity is pinned per residency.

**Boot:** arrive where the chain says the Wanderer is — the last `travel`'s `to_door_id` when no `arrival` follows it, else the latest `arrival`'s Door — if it is online, else `CURRENT_DOOR_ID` if online, else a random online Door. No Door online → retry with backoff (5 s doubling to 5 min) — never a crash loop. Door trouble (unreachable, refused, socket bind failure) is retried; local failures (invalid chain, `osp/0.1` chain, storage) fail boot. SIGTERM/SIGINT/SIGUSR2 handlers are registered before the first arrival, so shutdown works while no Door is reachable.

**One cycle** (`requestCycle("operator" | "timer" | "lost_session")`, single-flight — a second request resolves `busy`):

1. `detach()` — close the session socket. Inbound frames in the travel gap are **dropped, not queued**.
2. Choose the next Door: probe, then uniformly random among online Doors **other than the current one** (the current one only when it is the only one online; `random` is injectable).
3. `Session.depart({ toDoorId, minMemoryLines })` — witnessed memories, journal, departure, travel. Operator departures use `minMemoryLines: 1`, timer departures `NPC_RESIDENCY_MIN_LINES`. Failures retry with backoff (default 30 s, 120 s); after the last attempt the cycle is **abandoned**: `departBare(next)` (departure + travel, no memories; best effort) so the Wanderer is never stranded. A `lost_session` cycle skips straight to `departBare(next)` (the Door cannot witness anything for a session it no longer knows).
4. Arrive at the chosen Door: `hello` (identity check; `active_epoch` crash floor; `attest.memory` → `witnessesMemories`) → `Session.start` → bind a new `WsDoorSessionClient`. On failure: re-probe and retry with backoff at any online Door, until success or shutdown.

Outcomes: `cycled` / `abandoned` (both with `fromDoor`, `toDoor`, `fromEpoch`, `toEpoch`), `busy`, `shutting_down`, `aborted`. Each cycle logs `residency_cycle_outcome` (with `witnessed` / `declined` on `cycled`).

**Triggers:** timer — `NPC_RESIDENCY_MAX_MS` (default a day), checked every minute; a quiet stay still travels, it just forms no memories. Operator (on by default) — SIGUSR2 or a `wanderer depart` request file in `NPC_CONTROL_DIR` (polled every second). SIGUSR2 is always handled (ignored with a warning when the trigger is off) so a stray signal cannot terminate the daemon. Lost session — a heartbeat the Door refuses with `session_invalid` / `epoch_closed` (e.g. the Door restarted) logs `residency_session_lost` and runs a `lost_session` cycle, so the Wanderer moves on instead of staying mute. The daemon handle exposes `requestCycle`, `currentEpoch`, `currentDoorId`, `shutdown`.

**Shutdown during a cycle** aborts backoff / arrival waits, never re-arrives, and leaves the chain valid; the next boot arrives at a fresh epoch exactly as after any restart.

Tests: `test/residency-controller.test.ts` (Door choice, boot preference / no-Door retry, triggers, single-flight, depart retry / abandon → `departBare`, arrival retry, shutdown), `test/residency-config.test.ts`, `test/daemon-config.test.ts`, `test/residency-control-dir.test.ts`, `test/session-depart.test.ts` (witnessed / declined / journal / retry / no-witness / quiet stay / `departBare`), `test/daemon-residency.test.ts` and `test/daemon-residency-abandon.test.ts` (real daemon ↔ two door-sdk Doors over HTTP/WS: travel A → B, `verifyChain` with both keys, boot preference, rogue Door, quiet-stay timer travel, no-Door boot retry, SIGUSR2).
