# @npc/runtime

The Wanderer runtime: Self-Composer, Distiller, Navigator, Treasury, session loop.

## Brain (T2.1)

All LLM access goes through the provider-agnostic `Brain` interface:

```ts
import { AnthropicBrain, FakeBrain, loadBrainConfig } from "@npc/runtime";

const config = loadBrainConfig();
const brain = new AnthropicBrain({ config });
const text = await brain.complete([
  { role: "system", content: "You are the Wanderer." },
  { role: "user", content: "Where are you?" },
]);
```

`FakeBrain` provides deterministic scripted responses for unit tests.

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | yes | — | Anthropic API key |
| `NPC_BRAIN_MODEL` | no | `claude-sonnet-4-20250514` | Model id |
| `NPC_BRAIN_MAX_TOKENS` | no | `1024` | Default max output tokens |
| `NPC_BRAIN_TIMEOUT_MS` | no | `60000` | Request timeout (ms) |

See `ops/SECRETS.md` for the canonical secret registry.

### Live tests

Real-model smoke tests live under `test/live/` and are **skipped by default**. Run locally with:

```bash
LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-... pnpm --filter @npc/runtime test
```

CI never sets `LIVE_TESTS`; only unit tests with `FakeBrain` and injected mock clients run in CI.

## Self-Composer (T2.2)

Deterministic projection of a verified soulchain into a `systemPrompt` and `memoryIndex` for the Wanderer's session brain.

```ts
import { composeSelf, type ComposedSelf, type ComposeSelfOptions } from "@npc/runtime";

const composed: ComposedSelf = await composeSelf(store, {
  doorPublicKeys: [doorPublicKey], // required when chain has cosigned records
});
```

`doorPublicKeys` are verification-only; they must not affect prompt or index content.

**Composes in:** genesis charter, drift summaries (seq order), shard texts (seq order).

**Does not compose:** candidate, rejected, attestation/decision/transaction/sleep records; shard `journal`; drift `evidence` CIDs.

Prompt template lives at `src/prompts/composer/system.ts` (TS string constant, strategy a).

Golden files can be regenerated with:

```bash
pnpm --filter @npc/runtime generate:goldens
```

For integration tests, `test/helpers/memory-soul-store.ts` provides an in-memory `SoulStore` (reused by T2.4).

## Distiller (T2.3)

End-of-residency distillation: transcript lines → 5–20 first-person candidate memory shards (Door cosign shape) via `Brain`.

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
      // ... 4–19 more shards
    ],
  })
);

const shards: CandidateShard[] = await distillTranscripts(source, brain, {
  onPiiReject: (category) => {
    /* category only — never log shard text */
  },
});
```

`FileTranscriptSource` reads newline-delimited JSON; each line is `{ role: "user" | "assistant", text: string, author_id?: string }`. The file is deleted only after a successful run (`source.destroy()` on success).

Prompt templates live at `src/prompts/distiller/` (TS string constants, strategy a).

**Behavior:** Zod-parse Brain JSON (`{ shards: [{ text, tags? }] }`); one malformed-output retry; empty or over-length shards dropped (≤500 Unicode code points — reject, not truncate); built-in PII regex screen (email, phone, handle) with optional allowlist and category-only `onPiiReject` callback (`// T3.1: immune screen hook`); transcript destroyed only when validation passes and at least five shards remain.

**Out of scope:** soulchain append (callers append after cosign in `Session.depart`); full immune static screen (T3.1).

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
| `door` | yes | — | `DoorConnection` (`attest`, `heartbeat`, `cosign`) |
| `keyring` | yes | — | `Keyring` — soul signing + session-key derivation |
| `doorId` | yes | — | Door identifier (e.g. `discord:g`) |
| `timer` | yes | — | Injectable `Timer` for heartbeat scheduling |
| `clock` | yes | — | Injectable `Clock` for deterministic timestamps |
| `heartbeatIntervalMs` | no | `600000` | Heartbeat period |
| `maxHistoryMessages` | no | `40` | Rolling brain context cap |
| `doorPublicKeys` | no | — | Passed to `composeSelf` / chain verify when cosigners present |

`Session.start` composes self from the verified chain, derives a session key via HKDF-SHA-512 (`deriveSessionKey(doorId, epoch)`), appends an arrival attestation, and arms the heartbeat timer. Inbound frames are handled with `handleInbound`; call `drainAppends()` in tests to await async chain writes. Call `stop()` to end the residency. Before departure (T2.5), call `stop()` then `await drainAppends()` so no heartbeat attestation races the departure record — `Session.depart` does this automatically.

### Keyring boundary

`Session` never touches raw soul private keys. Attestation soul-signatures and record sealing go through `Keyring.signWithSoulKey`; outbound frames and heartbeat/attest requests use `Keyring.deriveSessionKey(doorId, epoch)` (returns a `SessionSigner`). Production loads the soul key via `loadSoulPrivateKeyFromPath`; tests use `SingleKeyKeyring`.

### PoP test vectors

Regenerate HKDF session-key derivation vectors:

```bash
pnpm --filter @npc/runtime generate:pop-vectors
```

Vectors live under `spec/pop/vectors/`; the runner is `test/pop-vectors.test.ts`.

### Door stub (integration tests)

`test/helpers/door-stub.ts` implements an in-process `DoorConnection` for T2.4/T2.5 and future `door-sdk` contract tests. It verifies soul/session signatures, returns door co-signatures on `attest`, implements two-phase `cosign` (review then per-shard commit with core-bound `door_cosig`), retires the session on departure attest, and exposes `verifyOutbound(frame)` for outbound frame checks. See `test/session-integration.test.ts` for the full 20-message residency acceptance test.

## Departure / handover (T2.5)

End-of-residency departure and manual handover to the next Door.

```ts
import { Session, move, type DepartOptions } from "@npc/runtime";
```

### `Session.depart`

Call on a live session to end the residency. Order of operations:

1. `stop()` + `await drainAppends()` — no further heartbeats or inbound handling
2. Distill transcripts → candidate shards (`distillTranscripts`)
3. Generate residency journal markdown (`generateJournal`) and write a journal file (`writeJournalFile`)
4. Two-phase Door cosign: `review` (approve/reject shards) then per-shard `commit` (core-bound `door_cosig`)
5. Append cosigned `memory` records (journal embedded on the first approved shard's body)
6. Append `departure` attestation (Door cosigned) and soul-signed `travel` attestation

Returns `{ journalPath, journalMarkdown, approvedShardIds, rejectedShardIds }`. The session remains not-live after depart.

### `move()`

Orchestrates depart at the current door and `Session.start` at the next:

```ts
import { move } from "@npc/runtime";

const { depart, session } = await move({
  session,
  transcript,
  journalDir,
  nextDoor,
  nextDoorId,
  arrive: { store, brain, keyring, timer, clock, doorPublicKeys },
});
```

No Door session traffic is accepted on the departed session during the travel gap.

### Operator CLI

```bash
wanderer move <door-id>
```

Bin at `packages/runtime/src/cli.ts` (`wanderer` in package `bin`). Production wiring is env-based (`SOUL_KEY_PATH`, `SOULCHAIN_DIR`, `TRANSCRIPT_PATH`, `JOURNAL_DIR`, `CURRENT_DOOR_ID`); tests inject `runMove` via `runWandererCli` deps.

### Journal

Markdown residency summary generated via Brain at depart time. Written to `journalDir` as a file; the same markdown is stored in the first approved `memory` record's `body.journal` field.

### Integration test

`test/handover-integration.test.ts` — full reside → depart → arrive across two stub Doors yields one continuous verifying chain; journal file on disk; epoch increments at the next door.

## Test

```bash
pnpm --filter @npc/runtime test
```
