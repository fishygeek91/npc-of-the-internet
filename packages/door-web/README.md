# @npc/door-web

The website Door: a small public web page where anyone can talk with the Wanderer **while it resides here**. One shared room (a porch, not a 1:1 chat). When the Wanderer is elsewhere the page says so — and, when `ATLAS_API_URL` is set, where it is now and since when.

It is an ordinary `door/0.2` Door (`@npc/door-sdk`): the runtime arrives with a soul-signed attest, binds its session WebSocket, and departs. If a memory witness is configured, the Door co-signs only memories its AI witness finds grounded in what was said on the porch.

In-browser signature checks and the embeddable replica shrine are specified in `spec/door/web.md`. The porch verifies each Wanderer line with `@npc/osp-core/browser` (not the package root): `public/verify.js` is the minified bundle of `src/browser/porch-entry.ts`, built by `scripts/bundle-browser.mjs`. A line verifies only for the open arrival at this Door. A bad proof returns `failed` and does not throw. A failed line stays on screen with the label `verification failed` and does not use the verified-speech style. The page fetches the chain from the porch's own `GET /chain/export` (a pass-through of `ATLAS_API_URL`); a failed export fetch drops the ETag. Visitor lines and system notices are not signed. The embeddable shrine and `MANUAL_TEST.md` are still the rest of T7.2b.

## Two listeners

| Listener | Default | Who talks to it |
|---|---|---|
| Door protocol (`POST /door/hello\|attest\|heartbeat`, `WS /door/session`) | `0.0.0.0:9091` | The Wanderer's runtime only. **Keep it on the internal network**; never publish it. |
| Visitor site | `0.0.0.0:8080` | The public, through a TLS reverse proxy. |

### Visitor site routes

- `GET /` · `GET /verify.js` · `GET /app.js` · `GET /app.css` — the page. `verify.js` is built (esbuild already in the lockfile, resolved through vitest → vite); the rest of `public/` is hand-written. Static files carry an `ETag`. `GET /api/verify-pins` → `{ soulPublicKey, doorId, doorPublicKey, atlasUrl }` (public keys only). `atlasUrl` is this porch's origin, never `ATLAS_API_URL`.
- `GET /chain/export` — pass-through of Atlas `GET /chain/export` when `ATLAS_API_URL` is set. One upstream fetch is shared, a successful body is reused for a few seconds, and a matching `If-None-Match` is a local `304`. Cross-origin `GET` is allowed without credentials (`Access-Control-Allow-Origin: *`). Browsers do not receive the server-side Atlas URL. An Atlas error is not cached.
- `GET /api/state` → `{ present, door: {id, name, description}, wanderer?, messages }` — `messages` are the last ≤ 100 room lines; `wanderer` (only while absent) is `{ last_seen_here, status?, door_id?, since? }`.
- `GET /api/events` — Server-Sent Events: `message` (a room line; Wanderer lines include `proof: { signed, sig }`), `reaction` (`{target, emoji, proof}`), `presence` (`{present, last_seen_here}`); `: ping` comment every 25 s. At most `DOOR_WEB_MAX_CLIENTS` streams (503 beyond) and 20 per client (429). GET only (`HEAD` → 405).
- `POST /api/say` — JSON `{name, text}`; `202 {id}` when relayed. `409 not_here` while absent, `400 invalid_name|invalid_text|invalid_json`, `413` over 4 KiB, `408` unless the whole body arrives within 5 s, `415` unless `Content-Type: application/json`, `403` for cross-site browser posts (`Sec-Fetch-Site`), `429 rate_limited` with `Retry-After`, `429 quiet_hours` (with `Retry-After` to UTC midnight) once `DOOR_WEB_DAILY_MAX` messages have been relayed today.
- `GET /healthz` → `200 ok`.

`present` means the Door has an active residency epoch **and** the runtime's session socket is bound. Presence is re-derived on lifecycle events and polled every 2 s (the WS server exposes no connect/disconnect hook).

## Behaviour

- **Visitors:** name 1–32 characters, text 1–500 (control, invisible format and other default-ignorable characters — zero-width, bidi, tag characters, Hangul fillers — stripped; text keeps the zero-width joiner and variation selectors for emoji). "The Wanderer" is reserved in any spelling: names are compared NFKC-folded, lowercased, letters only. Rate limits: 1 message / 3 s and 20 / 10 min per client, plus `DOOR_WEB_GLOBAL_PER_MIN` for everyone together, plus `DOOR_WEB_DAILY_MAX` relayed per UTC day (bounds model cost).
- **Client:** an IPv4 address, or an IPv6 **/64** (one subscriber owns a whole /64); IPv4-mapped IPv6 counts as its IPv4. Rate limits, SSE caps and `author_id` all use this key.
- **Relay:** each accepted message becomes an inbound frame — `author_id` is `web-<12 hex>`, a keyed hash of the client key under a secret salt rotated every UTC day (the raw IP never leaves the process); `author_display` is the name; `addressed` is true when the text mentions "wanderer" or starts with `@`. A leading `@` on words is dropped in the relayed text only (the runtime's immune screen treats `@handle` as PII).
- **The Wanderer:** outbound text appears as "The Wanderer" (a `reply_to` shows which message it answers) together with the signed frame. The page marks it verified only after `@npc/osp-core/browser` accepts the chain and the session signature. Reactions decorate the target message and carry the same proof. The page refetches `GET {ATLAS_API_URL}/chain/export` on load, when the tab becomes visible, and every 60 s. `connect-src` includes that Atlas origin.
- **Notices:** arrival → "The Wanderer has arrived."; departure → "The Wanderer has moved on.".
- **Privacy:** the room is an in-memory ring of 200 lines; nothing is written to disk. No cookies, no analytics; the name is remembered in the visitor's own `localStorage`. Message text and IPs are never logged.
- **Hardening:** strict CSP (`default-src 'self'`, `connect-src` is `'self'` plus the Atlas origin when `ATLAS_API_URL` is set, no inline script/style, `frame-ancestors 'none'`), `nosniff`, `no-referrer`; all text rendered with `textContent`; 10 s header timeout, 5 s body deadline; SSE readers with more than 64 KiB unsent are dropped.

## Config (env)

| Variable | Default | Purpose |
|---|---|---|
| `DOOR_KEY_PATH` | — (required) | Door Ed25519 private key file (32 raw bytes or base64url) — same format as door-discord |
| `SOUL_PUBLIC_KEY` | — (required) | Wanderer soul public key (base64url) |
| `DOOR_WEB_ID` | `web:home` | Door id on the wire (`web:<id>`) |
| `DOOR_HTTP_HOST` / `DOOR_HTTP_PORT` | `0.0.0.0` / `9091` | Door protocol listener (internal) |
| `DOOR_WEB_PUBLIC_HOST` / `DOOR_WEB_PUBLIC_PORT` | `0.0.0.0` / `8080` | Visitor site listener |
| `DOOR_WEB_COMMUNITY_NAME` | `The Wanderer's front porch` | Page title and `hello` community name |
| `DOOR_WEB_COMMUNITY_DESCRIPTION` | (short default) | Page subtitle and `hello` description |
| `DOOR_WEB_MAX_CLIENTS` | `200` | Max concurrent SSE streams |
| `DOOR_WEB_GLOBAL_PER_MIN` | `30` | Visitor messages per minute, all visitors together |
| `DOOR_WEB_DAILY_MAX` | `1500` | Visitor messages relayed to the Wanderer per UTC day; beyond it `/api/say` answers `429 quiet_hours` |
| `DOOR_WEB_TRUST_PROXY` | unset | `1` = rate-limit by the **last** `X-Forwarded-For` hop (set only behind your own proxy) |
| `ATLAS_API_URL` | unset | atlas-api base URL (e.g. `http://atlas-api:8787`) for "where is it now" (cached 30 s; network and nonsense yield null). `GET /state` bodies over 64 KiB (`ATLAS_STATE_MAX_BYTES`) throw `WebDoorError` `payload_too_large` before parse; `/api/state` still loads without whereabouts |
| `DOOR_WITNESS`, `DOOR_WITNESS_*` / `NPC_BRAIN_*` | — | Memory witness (see `@npc/door-sdk` `loadWitnessConfig`); `DOOR_WITNESS=off` disables it. Logged as `door_witness_config {enabled, model}` |

## Behind a TLS reverse proxy

Terminate TLS at a proxy, forward only the visitor port, and set `DOOR_WEB_TRUST_PROXY=1` so rate limits see real visitors. The proxy must **append** the peer address to `X-Forwarded-For` (the Door trusts only the last hop). SSE needs buffering off and a long read timeout. Caddy:

```caddyfile
porch.example.org {
  reverse_proxy door-web:8080 {
    flush_interval -1
  }
}
```

nginx:

```nginx
location / {
  proxy_pass http://door-web:8080;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_http_version 1.1;
  proxy_buffering off;          # SSE
  proxy_read_timeout 1h;        # SSE
}
```

Never route the public hostname to port 9091.

## Run

```bash
pnpm --filter @npc/door-web build
DOOR_KEY_PATH=./door.key SOUL_PUBLIC_KEY=... pnpm --filter @npc/door-web start
```

Image: `ops/Dockerfile.door-web` (non-root uid 10001, `HEALTHCHECK` on `/healthz` via `127.0.0.1` — keep `DOOR_WEB_PUBLIC_HOST` at its default inside the container).

## Test

```bash
pnpm --filter @npc/door-web test
```

The end-to-end test runs a real `Door` + `HttpDoorServer`/`WsDoorSessionServer`, a soul-signed arrival, and the door-sdk `WsDoorSessionClient` as the Wanderer.
