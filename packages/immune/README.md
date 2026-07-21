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
- **`ScreenCategory`** — `pii.email`, `pii.phone`, `pii.handle`, `injection.instruction`, `injection.role_marker`, `injection.url_payload`.
- **`ScreenOptions.allowlist`** — exact-span allowlist for PII matches only; injection is never allowlisted.
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
