# @npc/door-sdk

Shared library for building Door adapters (`door/0.2`, `spec/door/api.md`): wire schemas, signing helpers, host policy hooks, the transport-agnostic `Door` core, HTTP/WS transports, and the reference AI memory witness.

The Wanderer is in one place at a time. Every outlet is a Door: while it resides here the Door relays community messages in and delivers its words out; at departure the Door's **witness** checks each memory the Wanderer wants to keep against the Door's own record of the stay and co-signs it. Witnessed memories are final — there is no approval queue.

## Public API

### `Door`

```ts
const door = new Door({ doorId, doorKeypair, soulPublicKey, clock, policy });
// optional: residencyRecord: { communityChars, wandererChars }, maxMemoryAttests (default 32)
```

| Method | Purpose |
|---|---|
| `hello(req)` | `POST /door/hello` — signed community descriptor and `capabilities` |
| `attest(req)` | `POST /door/attest` — `arrival`, `heartbeat`, `memory`, `departure`; returns `door_cosig` over the raw `core` bytes |
| `heartbeat(req)` | `POST /door/heartbeat` — session-key presence ping (transport ack) |
| `bindSession(params)` | verify a `WS /door/session` binding proof |
| `handleOutbound(frame)` / `verifyOutbound(frame)` | accept a session-signed outbound frame (signature, freshness, `msg_id` replay) |
| `createInboundFrame({ msg_id, body })` | build an inbound frame for the active epoch (and record it) |
| `handleControl(frame)` / `createSessionEndFrame(epoch, reason)` | Door-signed `pong` / `session_end` |
| `addOutboundListener(fn)` | called once per **accepted** outbound frame (never for replays or bad signatures) — platform adapters deliver the Wanderer's words from here |
| `addSessionLifecycleListener(fn)` | `{ type: "arrived" \| "retired" \| "superseded", doorId, epoch }` — e.g. announce presence, close stale sockets |
| `getActiveEpoch()`, `getActiveSessionPubkey()`, `getLastKnownEpoch()`, `capabilities()`, `witnessesMemories()`, `residencyRecordSize()` | state for transports and ops |

Both `add…Listener` calls return an unsubscribe function; a throwing listener is isolated (the protocol call still succeeds and other listeners still run).

**Core binding.** `attest` never co-signs arbitrary bytes. `core` must be canonical OSP JSON for this Door's residency (`door:<door_id>/epoch:<epoch>`): an `attestation` of the requested kind for presence attests, or for `memory` an `osp/0.2` `memory` record whose body is exactly a shard (`kind, text_cid, text_hash, distilled_at`) or a journal (`kind, journal_cid, journal_hash, written_at`) whose hash binds the request `text` (side-blob encoding; shard text ≤ 500 code points). Anything else is `core_invalid`.

**Memory attests** (`kind: "memory"`, with `text`) are accepted only for the active session (after arrival, before departure). The Door binds `core` to `text`, then asks `policy.witnessMemory` to judge `text` against its own record of the residency, and re-checks the session after the witness answers (a departure or supersession meanwhile means no co-signature). Outcomes: `door_cosig` (witnessed), `witness_declined` (422, `details.reason` ∈ `ungrounded | private | harmful | manipulation | other`, final), `witness_unavailable` (503 — the witness threw or returned a malformed verdict; retry later, an outage is never a decline), `unsupported_kind` when the Door has no witness.

Per epoch (all reset on arrival, departure and supersession), without asking the witness:

- **Decisions are final.** A repeat of a decided text (same kind and side-blob hash) gets the same answer: the same decline, or a fresh `door_cosig`.
- **Budget.** At most `maxMemoryAttests` witness calls (`DEFAULT_MAX_MEMORY_ATTESTS` = 32; every call counts); past it, new texts are declined `other` ("memory budget exhausted").
- **Journal.** Needs at least one witnessed shard (else declined `ungrounded`) and is judged against those shards (`witnessedShards`); after one journal is witnessed, another is declined `other`.

### `HostPolicy`

| Field | Purpose |
|---|---|
| `community` | descriptor returned by hello |
| `capabilities` | advertised capabilities; `attest.memory` is added automatically when `witnessMemory` is set and removed when it is not |
| `isAvailable?()` | `false` → hello answers `door_unavailable` |
| `acceptArrival?(args)` | throw to refuse an arrival (`not_hosting`) |
| `witnessMemory?(input)` | the memory witness: `({ doorId, epoch, kind: "shard" \| "journal", text, transcript, witnessedShards }) => Promise<{ witnessed: true } \| { witnessed: false, reason }>`; throw when no verdict can be reached. Unset = no memories are formed at this Door |

### `ResidencyRecord`

The Door's in-memory record of the active epoch — community messages relayed inbound (`createInboundFrame`) and Wanderer text accepted outbound (`handleOutbound`), oldest first. It is the witness's only input (never a transcript supplied by the Wanderer), is bounded per role to the most recent `communityChars` of community text (`DEFAULT_COMMUNITY_RECORD_CHARS` = 90 000) and `wandererChars` of the Wanderer's (`DEFAULT_WANDERER_RECORD_CHARS` = 30 000), so the Wanderer cannot evict what the community said (set via `DoorOptions.residencyRecord`); it is never persisted, and is cleared on arrival, departure and supersession.

### Reference AI witness

```ts
const config = loadWitnessConfig(process.env); // null = witnessing off
const policy: HostPolicy = {
  community,
  capabilities: ["session.text", "heartbeat", "attest"],
  ...(config === null ? {} : { witnessMemory: createAiWitness({ complete: openAiCompatComplete(config) }) })
};
```

- **`createAiWitness({ complete, attempts?, randomTag? })`** — one independent model call per memory with the fixed rubric `WITNESS_SYSTEM_PROMPT` (`src/prompts/witness.ts`, snapshot-tested). Untrusted text goes only in the user prompt (`buildWitnessUserPrompt`), inside delimiters that carry a fresh random tag per attempt; each record line is one JSON object (`{"role","author","text"}`), so names and newlines cannot forge a role or a line. A journal prompt also lists the shards witnessed this epoch, and the rubric judges the journal against them. Failed calls and unparseable replies are retried (default 2 attempts), then thrown — never turned into a witness.
- **`parseWitnessReply(reply)`** — the verdict is the JSON object that ends the reply (reasoning before it and a closing code fence after are fine). A reply that does not end in a verdict object is `null`, so a truncated answer never falls back to a verdict quoted earlier.
- **`openAiCompatComplete(settings)`** — `CompleteFn` over any OpenAI-compatible chat-completions API (`temperature: 0`, bearer auth, OpenRouter `provider.only` when an allowlist is set, `max_tokens` default 2048, timeout). HTTP errors never echo the response body; a reply cut off at `max_tokens` is an error.
- **`loadWitnessConfig(env)`** — each `DOOR_WITNESS_*` value falls back to the matching `NPC_BRAIN_*` value, so a Door beside the Wanderer's runtime needs no extra setup. Returns `null` when off or nothing is configured; throws `WitnessConfigError` (with `envVar`, never a secret) when configuration is partial or invalid.

| Setting | Env (fallback) | Default |
|---|---|---|
| on/off | `DOOR_WITNESS=off` (also `0`, `false`) | on when configured |
| base URL | `DOOR_WITNESS_BASE_URL` (`NPC_BRAIN_BASE_URL`) | required |
| API key | `DOOR_WITNESS_API_KEY`, `DOOR_WITNESS_API_KEY_FILE` (`NPC_BRAIN_API_KEY`, `NPC_BRAIN_API_KEY_FILE`) — first set wins, in that order | required |
| model | `DOOR_WITNESS_MODEL` (`NPC_BRAIN_MODEL`) | required |
| OpenRouter allowlist | `DOOR_WITNESS_PROVIDER_ALLOWLIST` (`NPC_BRAIN_PROVIDER_ALLOWLIST`, only with the Brain's base URL), comma-separated | none |
| timeout | `DOOR_WITNESS_TIMEOUT_MS` (integer ≥ 1000) | 60000 |

### Wire, signing, errors

- **Schemas** — Zod validators for every request/response and WebSocket frame (`AttestRequestSchema` requires `text` for `memory` and forbids it otherwise, ≤ `MEMORY_ATTEST_TEXT_MAX` = 32 000 code points; `HelloResponseSchema.capabilities` accepts unknown strings for forward compatibility; `WitnessReasonSchema`). `DOOR_PROTOCOL_VERSION` = `door/0.2`.
- **Signing** — canonical payload builders (`attestSigningPayload`, `heartbeatSigningPayload`, `outboundSigningPayload`, `sessionBindSigningPayload`, response payloads), `signDoorCosig` / `verifyDoorCosig` over raw `core` bytes. Attest `text` is not in the request signature: `core` binds it by hash.
- **`DoorError`** — typed errors with stable `code`, `httpStatus` and optional `details`.

### Transports

- **`InProcessDoorConnection`** — same-process `DoorConnection` for tests and wiring.
- **`HttpDoorServer`** — `POST /door/hello`, `/door/attest`, `/door/heartbeat` (bodies ≤ `MAX_HTTP_BODY_BYTES`, schema-validated, `DoorError` → status + JSON body).
- **`HttpDoorConnection`** — `DoorConnection` over HTTP. Requires a verified `hello()` first; verifies every response `door_sig` and `door_cosig`; Door error responses become `DoorError` (with `details`, e.g. the witness `reason`). Timeouts (→ `door_unavailable`): `memoryTimeoutMs` for `memory` attests (`DEFAULT_MEMORY_ATTEST_TIMEOUT_MS` = 180 000 — the witness may be slow), `timeoutMs` for everything else (`DEFAULT_HTTP_TIMEOUT_MS` = 30 000).
- **`WsDoorSessionServer`** — `WS /door/session`: session binding (close `4401` on failure), outbound frames through `Door.handleOutbound`, ping/pong, `session_end` and close on departure/supersession. Frames are bounded (`WS_MAX_PAYLOAD_BYTES`) and a malformed peer never crashes the process.
- **`WsDoorSessionClient`** — Wanderer-side session client: binds, delivers inbound/control/error frames via callbacks, sends signed outbound frames, answers `ping`, reconnects with exponential backoff (fatal on `4401`).

`@npc/runtime` re-exports Door wire types from this package; integration tests use `DoorStub`, a thin wrapper around `Door`.

## Test

```bash
pnpm --filter @npc/door-sdk test
```
