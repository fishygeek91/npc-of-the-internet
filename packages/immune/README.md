# @npc/immune

Memory immune system: static screens, verifier ensemble (future), quarantine (future).

## Static screen (v0.1)

```ts
import { screenText, type ScreenCategory } from "@npc/immune";

const result = screenText(untrustedText, { allowlist: ["@allowed_bot"] });
if (!result.ok) {
  for (const category of result.categories) {
    logRejection(category); // category only — never the input text
  }
}
```

### API

- **`screenText(text, opts?)`** — returns `{ ok: true }` or `{ ok: false, categories }`.
- **`normalizeScreenText(text)`** — the *matching view* used before screening (applied internally by `screenText`; exported for tests and callers that need the same view): compatibility decomposition, Hangul fillers / Braille blank → space, strip format + default-ignorable characters (ZW*, CGJ, variation selectors) and combining marks, any-script decimal digits → ASCII, Cyrillic/Greek homoglyphs → Latin, NFKC. Lossy by design — match against it, never display or persist it.
- **`ScreenCategory`** — `pii.email`, `pii.phone`, `pii.handle`, `injection.instruction`, `injection.role_marker`, `injection.url_payload`.
- **`ScreenOptions.allowlist`** — exact-span allowlist for PII matches only; injection is never allowlisted. Matched spans and allowlist entries are both passed through `normalizeScreenText` before comparison, so raw and normalized spellings of an entry behave the same.
- **`ScreenLogger`** / **`ScreenSite`** — types for category-only rejection sinks at call sites.

### Purity

`screenText` is pure and synchronous: no filesystem, network, `Date`, `Math.random`, or logging.

### No-payload rule

Rejections, results, and log callbacks must never include matched spans or input text — **categories only**.

### Call sites (planned wiring)

- **Session inbound** — screen Door message text before it enters residency context (`session.inbound`).
- **Distiller** — screen each candidate shard before quarantine (`distill.shard`).

## Develop

```bash
pnpm --filter @npc/immune build
pnpm --filter @npc/immune test
```
