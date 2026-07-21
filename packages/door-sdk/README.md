# @npc/door-sdk

Shared library for building Door adapters: wire schemas, signing helpers, host policy hooks, and transport-agnostic `Door` core.

## Public API

- **`Door`** — transport-agnostic host core (`hello`, `attest`, `heartbeat`, `cosign`, session bind, WebSocket frame helpers)
- **Schemas** — Zod validators for Door API request/response and WebSocket frame types (`AttestRequestSchema`, `CosignRequestSchema`, `InboundFrameSchema`, …)
- **Signing** — canonical payload builders (`attestSigningPayload`, `cosignReviewSigningPayload`, `heartbeatSigningPayload`, …)
- **`HostPolicy`** — community descriptor, capabilities, and per-shard cosign review hooks
- **Transports** — `InProcessDoorConnection`, `HttpDoorServer`, `WsDoorSessionServer`
- **`DoorError`** — typed API errors with stable machine codes

`@npc/runtime` re-exports Door wire types from this package; integration tests use `DoorStub`, a thin wrapper around `Door`.

## Test

```bash
pnpm --filter @npc/door-sdk test
```
