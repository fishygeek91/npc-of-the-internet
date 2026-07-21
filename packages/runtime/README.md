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

## Test

```bash
pnpm --filter @npc/runtime test
```
