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

## Test

```bash
pnpm --filter @npc/runtime test
```
