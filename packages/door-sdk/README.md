# @npc/door-sdk

Shared library for building Door adapters: wire schemas, signing helpers, host policy hooks, and transport-agnostic `Door` core.

## Public API

- **`Door`** — transport-agnostic host core (`hello`, `attest`, `heartbeat`, `cosign`, session bind, WebSocket frame helpers)
- **Schemas** — Zod validators for Door API request/response and WebSocket frame types (`AttestRequestSchema`, `CosignRequestSchema`, `InboundFrameSchema`, …)
- **Signing** — canonical payload builders (`attestSigningPayload`, `cosignReviewSigningPayload`, `heartbeatSigningPayload`, …)
- **`HostPolicy`** — community descriptor, capabilities, and per-shard cosign review hooks
- **Transports** — `InProcessDoorConnection`, `HttpDoorServer`, `WsDoorSessionServer`, `HttpDoorConnection`, `WsDoorSessionClient`
- **`DoorError`** — typed API errors with stable machine codes

`@npc/runtime` re-exports Door wire types from this package; integration tests use `DoorStub`, a thin wrapper around `Door`.

### Network clients

- **`HttpDoorConnection`** — `DoorConnection` over HTTP (`POST /door/hello`, `/door/attest`, `/door/heartbeat`, `/door/cosign`). Parses success bodies with Zod; throws `DoorError` on Door error responses.
- **`WsDoorSessionClient`** — WebSocket session client for `WS /door/session`. Binds with `SessionBindParams`, delivers inbound/control/error frames via callbacks, sends signed outbound frames, auto-responds to Door `ping` with `pong`, and reconnects with exponential backoff (fatal on close code `4401`).

## Test

```bash
pnpm --filter @npc/door-sdk test
```
