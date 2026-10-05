# Door API

**Spec version:** `door/0.1`  
**License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)

A Door is any host adapter that implements this contract so a Wanderer runtime can reside, exchange messages, attest presence, and obtain co-signatures at departure. This document is the v0.1 prose contract; implementations derive Zod types and tests from it. There is no separate OpenAPI YAML for v0.1.

Normative references: [ARCHITECTURE.md](../../ARCHITECTURE.md) §4 (Doors), [Proof-of-Presence overview](../pop/overview.md) (session keys, attestations), [OSP records](../osp/records.md) (soulchain envelope and cosigners).

---

## Overview

| Method | Path | Direction | Summary |
|--------|------|-----------|---------|
| `POST` | `/door/hello` | Wanderer → Door | Capability negotiation + community descriptor (Door-signed response) |
| `WS` | `/door/session` | Bidirectional | Residency message stream; outbound Wanderer messages carry session-key signatures |
| `POST` | `/door/heartbeat` | Wanderer → Door | Presence ping (~10 minute cadence); Door ack |
| `POST` | `/door/attest` | Wanderer → Door | Door co-signature over a soulchain attestation `core` (arrival / departure / heartbeat) |
| `POST` | `/door/cosign` | Wanderer → Door | Host review + co-sign candidate memory shards at departure |

Ghost implements five HTTP/WS paths. The four ARCHITECTURE.md discovery/session/presence/memory flows remain; `/door/attest` is the explicit PoP co-signing path required so arrival/departure (and soulchain heartbeats) can fill non-empty `cosigners` without a circular signing payload.

**Base URL:** implementation-defined (e.g. `https://door.example.com` for network transports). Path prefixes are fixed.

**Content type:** `application/json` for HTTP bodies and WebSocket text frames unless noted.

**v0.1 in-process transport:** For integration tests (`door-sdk`, runtime T2.4/T2.5), an in-process transport MUST use the **same JSON message shapes** as the network transports. No HTTP server or WebSocket socket is required in tests — callers invoke the same request/response and frame handlers directly. Wire encoding differences (headers, status codes on the in-process error path) are transport concerns; the payload schemas are identical.

**Untrusted inbound text:** All `text` (and similar string fields) arriving from a Door toward the Wanderer — community messages, host commands, shard review prompts — are **untrusted**. The runtime MUST NOT place them in system prompts without passing through the immune package static screen (T3.1). Doors SHOULD still apply basic rate limits and size caps; that does not replace immune screening on the Wanderer side.

---

## Common types

### Identifiers

| Type | Format | Example | Notes |
|------|--------|---------|-------|
| `door_id` | `platform:community-id` | `discord:123456789012345678` | Stable identity of a hosted community. **No** leading `door:` prefix. `<platform>` is a short slug (`discord`, `web`, `matrix`, …). `<community-id>` is opaque to the protocol. |
| `epoch` | unsigned integer ≥ 1 | `77` | **Global** residency epoch from the Wanderer soulchain (PoP). Not per-Door. The Wanderer supplies `epoch` on every call; Doors MUST NOT allocate or invent epochs. Only one valid session key may exist for a given epoch globally. |
| `msg_id` | string | `msg_01HY…` | Unique within a session stream. Implementations MAY use ULID/UUID; the wire format is opaque. |
| `shard_id` | string | `shard_01HY…` | Unique within a cosign request. |

**Residency string** (used in soulchain records, not on every Door wire message): `door:<platform>:<community-id>/epoch:<n>` — e.g. `door:discord:123456789012345678/epoch:77` — i.e. `door:` + `door_id` + `/epoch:` + epoch.

### Keys and signatures

All public keys and signatures on the Door wire are **opaque strings** encoding raw Ed25519 material as **base64url** (no padding), matching OSP soulchain encoding in `spec/osp/records.md`. CIDs (when referenced) remain multiformats CID strings (`bafy…`).

| Field | Role |
|-------|------|
| `soul_pubkey` | Wanderer identity (long-lived soul key). |
| `door_pubkey` | Door host identity (long-lived Door key). |
| `session_pubkey` | Per-epoch session subkey; bound to `door_id + epoch`. |
| `sig` | Ed25519 signature bytes, base64url-encoded. Signer identified by context (Door key, session key, or soul key). |
| `door_sig` / `door_cosig` | Signature under `door_pubkey`. |

**Canonical signing payload:** JSON object containing all signed fields, **sorted keys**, UTF-8, no insignificant whitespace, excluding the signature field itself — same rules as OSP canonical serialization. Exact conformance vectors will live in `spec/door/vectors/` (future task); implementers MUST match the algorithm in `osp-core` once vectors land.

**Session-key binding (v0.1):** The session key is derived from the soul key for `(door_id, epoch)` and recorded in an `attestation` record at arrival. Every outbound Wanderer message on `/door/session`, every `/door/heartbeat` request, every `/door/attest` request after arrival, and every `/door/cosign` request MUST include `session_pubkey` and `sig` under that session key (arrival attest uses the soul key — see `/door/attest`). Receivers MUST reject payloads where `session_pubkey` does not match the active session for the claimed `(door_id, epoch)` or where `sig` fails verification. **Exception — cosign commit:** a `/door/cosign` commit is bound to the session that authenticated the **reviewed** epoch's review, not to the active session; it is valid after departure and, at a Door advertising `cosign.past_epochs`, while a later epoch is active (see **Review retention**).

### Timestamps

ISO 8601 UTC strings with millisecond precision, e.g. `2026-07-20T15:04:05.123Z`. Field name `issued_at` on Wanderer-originated payloads; `received_at` on Door-originated acknowledgements.

**Freshness:** Doors MUST reject `/door/attest` and `/door/cosign` requests whose `issued_at` differs from the Door clock by more than a configured absolute skew (default **±5 minutes** / `300_000` ms) with `timestamp_stale` (`401`). Invalid / non-ISO `issued_at` values are treated as stale. The same window applies to `outbound` session frames (checked after signature verification). Freshness MUST be checked before any host-visible side effect (e.g. posting shards for review). Freshness is checked **once, on receipt**: a Door with asynchronous host review MUST NOT re-apply the `issued_at` check after the review completes (session binding, epoch state and the request signature are still re-verified) — a request that was fresh when received never fails `timestamp_stale` because a human took longer than the skew window to review it.

### `CommunityDescriptor`

Describes the hosted community for Navigator / operator display.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable community name. |
| `description` | string | yes | Short prose description (≤ 2000 chars). |
| `platform` | string | yes | Same slug as in `door_id` (e.g. `discord`). |
| `rules_url` | string | no | URL to community rules or charter addendum. |
| `invitation_required` | boolean | yes | If true, Wanderer MUST NOT arrive without a valid invitation (enforced outside this API). |

### `Capability`

Machine-readable feature flags the Door supports. v0.1 registered values:

| Value | Meaning |
|-------|---------|
| `session.text` | Text messages on `/door/session`. |
| `session.threads` | Thread/reply metadata on inbound messages (optional `reply_to`). |
| `heartbeat` | Door accepts `/door/heartbeat` presence pings. |
| `attest` | Door accepts `/door/attest` soulchain co-signatures. |
| `cosign.manual` | Host manually approves shards on `/door/cosign` (v0.1 default). |
| `cosign.auto` | Door may auto-approve shards matching host policy (not required in v0.1). |
| `session.reactions` | Door delivers outbound `reaction` bodies (single-emoji reaction to a prior message) and accepts text-less outbound frames that carry only a `reaction`. |
| `session.addressing` | Door sets inbound `addressed` when the platform shows the message is aimed at the Wanderer (e.g. @mention, reply to one of its messages). |
| `cosign.past_epochs` | Door retains each completed cosign review per epoch across later arrivals (bounded — see `/door/cosign` **Review retention**), so commit-phase requests for a past epoch are accepted while a newer residency is live. |

**Additive capabilities (`session.reactions`, `session.addressing`, `cosign.past_epochs`).** These extend `door/0.1` without changing any previously required field: every new field is optional, and a Wanderer MUST NOT send a text-less or `reaction`-bearing outbound frame unless the Door advertised `session.reactions` in `hello`. `cosign.past_epochs` adds no wire field; it changes which commit requests a Door accepts (and adds the `review_not_retained` error), and a Wanderer MUST NOT rely on commits for a past epoch after a newer arrival unless the Door advertised it. Doors and runtimes from the same release ship together; a runtime that predates these values rejects a `hello` that lists them, so upgrade the Door and runtime in lockstep.

### Error shape (all endpoints)

Failed HTTP calls return a JSON body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error.code` | string | yes | Stable machine code (see tables per endpoint). |
| `error.message` | string | yes | Human-readable explanation. |
| `error.details` | object | no | Structured context (e.g. `{ "field": "epoch", "expected": 77, "got": 76 }`). |

WebSocket errors use a **control frame** (see `/door/session`) with the same `error` object in the body.

Typical HTTP status mapping:

| Status | When |
|--------|------|
| `400` | Malformed body, failed schema validation, bad signature encoding. |
| `401` | Missing or invalid authentication / session binding. |
| `403` | Valid session but action not permitted (e.g. cosign while not departing). |
| `404` | Unknown `door_id` or no active residency for `(door_id, epoch)`. |
| `409` | Epoch/session conflict (e.g. epoch already closed, arrival epoch replay). |
| `410` | State the request depends on is permanently gone (e.g. `review_not_retained`). |
| `413` | Request body exceeds Door transport size limit. |
| `422` | Semantically invalid (e.g. shard over length limit). |
| `500` | Door internal error. |

---

## `POST /door/hello`

### Purpose

Discover a Door's capabilities and community descriptor **before** opening a residency session. The response is **signed by the Door identity key** so the Wanderer and third parties can verify the descriptor was issued by the claimed host. Used during destination selection and arrival preparation.

This endpoint is idempotent and does not mutate residency state.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | Caller spec version; MUST be `door/0.1` for this document. |
| `soul_pubkey` | string | yes | Wanderer soul public key (base64url). |
| `client` | string | no | Runtime identifier for logging (e.g. `npc-runtime/0.1.0`). |

### Response `200`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.1`. |
| `door_id` | string | yes | This Door's stable id. |
| `door_pubkey` | string | yes | Door public key (base64url). |
| `active_epoch` | integer \| null | yes | If this Door currently believes it is hosting an active residency, the global `epoch` it last accepted; otherwise `null`. **Informational only** — the Wanderer is authoritative for epoch allocation. Doors MUST NOT expose an `epoch_next` (they cannot know the next global epoch). |
| `capabilities` | string[] | yes | Subset of registered `Capability` values. |
| `community` | `CommunityDescriptor` | yes | Community metadata. |
| `issued_at` | string | yes | Door timestamp. |
| `sig` | string | yes | Door signature over all other response fields (canonical JSON). |

### Auth / signing

- **Request:** No signature required. Rate limiting recommended.
- **Response:** `sig` MUST verify under `door_pubkey`. Wanderer MUST reject responses with invalid or missing signatures.

### Errors

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `unsupported_version` | `400` | `protocol_version` not supported. |
| `invalid_request` | `400` | Schema validation failed. |
| `door_unavailable` | `503` | Door temporarily not accepting discovery. |

---

## `WS /door/session`

### Purpose

Bidirectional **residency message stream** for the active epoch. Community-originated traffic flows **inbound** to the Wanderer; Wanderer replies flow **outbound** to the community. The WebSocket stays open for the duration of the residency (until depart or disconnect).

### Connection

**URL:** `wss://<host>/door/session` (or `ws://` in dev).

**Query parameters** (or first text frame if the transport requires a post-connect handshake):

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `door_id` | string | yes | Active residency door. |
| `epoch` | integer | yes | Active residency epoch. |
| `session_pubkey` | string | yes | Current session public key. |
| `session_sig` | string | yes | Session-key signature over `{ door_id, epoch, session_pubkey }` proving binding (or soul-key signature at arrival per PoP — v0.1: session subkey proof). |

Door MUST reject the connection with WebSocket close code `4401` if session binding fails, or send an `error` control frame (below) before closing. The close reason is a short fixed string (e.g. `session bind failed: signature_invalid`, always ≤ 123 UTF-8 bytes per RFC 6455); Doors MUST NOT echo validation output or request data in it.

Doors MUST bound inbound frame size (reference implementation: 256 KiB; larger frames close the socket with `1009`) and MUST treat WebSocket protocol violations (e.g. unmasked client frames) as a per-connection failure, never a host-process failure.

### Frame envelope

Every text frame is a JSON object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `inbound`, `outbound`, `control`, or `error`. |
| `door_id` | string | yes | Copied from session binding. |
| `epoch` | integer | yes | Copied from session binding. |
| `msg_id` | string | yes | Unique message id. |
| `issued_at` | string | yes | Sender timestamp. |
| `body` | object | yes | Type-specific payload (tables below). |
| `sig` | string | cond. | Required on `outbound` (session key). Required on `control` when Door originates. Omitted on `inbound` community text (Door vouches by relay). |

### `body` for `type: "inbound"` (Door → Wanderer)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | **Untrusted** community message text. Max 4000 chars in v0.1. |
| `author_id` | string | yes | Opaque platform-specific author id (not necessarily PII; immune screen still required). |
| `author_display` | string | no | Display name for logging/UI only; untrusted. |
| `reply_to` | string | no | `msg_id` of parent message when `session.threads` capability present. |
| `channel_id` | string | no | Opaque sub-channel/thread id within the community. |
| `addressed` | boolean | no | `session.addressing`: Door-observed signal that the message is aimed at the Wanderer (platform @mention, or a reply to one of the Wanderer's messages). Advisory and untrusted; the Wanderer decides whether to answer. |

### `body` for `type: "outbound"` (Wanderer → Door)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | cond. | Wanderer response text. Max 4000 chars in v0.1. Required unless `reaction` is present. |
| `reply_to` | string | no | `msg_id` of the message being answered. The Door maps it to a platform reply reference (e.g. a Discord message reply). Doors that cannot resolve it post the text without a reference. |
| `channel_id` | string | no | Route reply to the same channel as inbound. |
| `reaction` | object | no | `session.reactions` only: `{ emoji, target_msg_id }`. `emoji` is exactly one Unicode emoji grapheme (≤ 32 UTF-16 units; no custom-emoji syntax). A keycap emoji is only `[0-9#*]`, optional U+FE0F, then U+20E3 (U+20E3 after any other character, or alone, is rejected). `target_msg_id` is the `msg_id` of the message to react to. A frame MAY carry both `text` and `reaction`. |

At least one of `text` or `reaction` MUST be present. The session-key `sig` covers the whole body, including `reaction`, so reactions carry the same Proof-of-Presence guarantee as speech.

**Replay:** Doors MUST reject an `outbound` frame whose `msg_id` was already accepted in the current epoch with `msg_replay` (reference implementation: the last 10 000 accepted `msg_id`s per epoch, reset on arrival; the `issued_at` freshness window bounds replay beyond that).

**Platform delivery:** Wanderer text is untrusted on the host platform too: Doors MUST NOT let it trigger platform mentions / mass notifications (e.g. Discord `@everyone`, `@here`, role or user pings, reply-author pings). A Door whose platform caps message length below 4000 chars MAY post `text` as several consecutive platform messages (splitting on line/word boundaries, never inside a code point); only the first carries the `reply_to` reference, and the frame's `msg_id` maps to all parts. Protocol `msg_id` ↔ platform id mappings are per epoch (Wanderer `msg_id` counters restart with each session).

**Silence is valid.** The Wanderer is not obliged to emit an outbound frame for every inbound frame. Reading without answering, answering several inbound messages with one frame, or reacting instead of speaking are all conforming behaviours; Doors MUST NOT treat a missing reply as an error.

**Signing:** `sig` MUST be a session-key signature over the full frame excluding `sig`, with `type` = `outbound`. Door MUST verify before delivering to the community.

### `body` for `type: "control"`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | `ping`, `pong`, `session_end`, or `backpressure`. |
| `reason` | string | no | Human-readable detail for `session_end` / `backpressure`. |

Either party MAY send `ping`; the other MUST respond with `pong`. Door sends `session_end` when the host closes the residency (operator action, platform disconnect) **and** when an arrival supersedes a prior epoch or a departure attest completes — transports MUST close WebSocket clients bound to the retired epoch and MUST NOT deliver further inbound frames to those sockets.

### `body` for `type: "error"`

Same object as HTTP `error` shape, plus optional `related_msg_id`.

### Auth / signing

- **Connection:** Session binding via query/handshake parameters.
- **Outbound frames:** Session-key `sig` required.
- **Inbound frames:** No Wanderer signature; Door is responsible for authenticating community members on its platform.
- **Control frames:** Sign when sent by Door (`sig` under `door_pubkey`); `ping`/`pong` from Wanderer MAY omit `sig`.

### Errors

| `error.code` | When |
|--------------|------|
| `session_invalid` | Bad or expired `(door_id, epoch, session_pubkey)` binding. |
| `signature_invalid` | `sig` verification failed on `outbound`. |
| `message_too_large` | `text` exceeds limit. |
| `session_closed` | Residency already ended. |
| `rate_limited` | Door throttling. |
| `timestamp_stale` | `outbound` `issued_at` outside the freshness window. |
| `msg_replay` | `outbound` `msg_id` already accepted in this epoch (`409` where an HTTP status applies). |

---

## `POST /door/heartbeat`

### Purpose

**Presence attestation** during an active residency. The Wanderer periodically asserts it is still operating at `(door_id, epoch)` under the current session key. Third parties can correlate heartbeats with outbound session messages to detect cloning or stale presence.

**Cadence:** ~10 minutes in v0.1 (runtime uses an injected timer; exact interval is operator-configurable but SHOULD default to 600 seconds).

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.1`. |
| `door_id` | string | yes | Active residency. |
| `epoch` | integer | yes | Active epoch. |
| `session_pubkey` | string | yes | Session public key. |
| `seq` | integer | yes | Monotonic heartbeat sequence for this epoch, starting at `1`. |
| `issued_at` | string | yes | Wanderer timestamp. |
| `sig` | string | yes | Session-key signature over all other request fields. |

### Response `200`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `door_id` | string | yes | Echo. |
| `epoch` | integer | yes | Echo. |
| `seq` | integer | yes | Echo. |
| `accepted` | boolean | yes | `true` if attestation recorded. |
| `received_at` | string | yes | Door timestamp. |
| `door_sig` | string | yes | Door signature over `{ door_id, epoch, seq, accepted, received_at }`. |

Door SHOULD persist or forward presence pings for local ops. **Soulchain** heartbeat records still require a Door co-signature over the OSP `core` payload, obtained via `POST /door/attest` with `kind: "heartbeat"` (the HTTP `door_sig` above is a transport ack only and is **not** the soulchain cosigner).

### Auth / signing

- **Request:** Session-key `sig` required; MUST match active residency.
- **Response:** `door_sig` required as a transport ack (not the OSP cosigner).

### Errors

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `session_invalid` | `401` | No active session for `(door_id, epoch)`. |
| `signature_invalid` | `401` | `sig` failed verification. |
| `epoch_closed` | `409` | Residency already departed. |
| `seq_replay` | `409` | `seq` not greater than last accepted (if Door tracks). |

---

## `POST /door/attest`

### Purpose

Obtain a **Door co-signature** for a soulchain `attestation` record. The Wanderer builds the unsigned envelope, computes the OSP **`core`** bytes (canonical JSON with `cosigners` and `sig` omitted — see `spec/osp/records.md`), and asks the Door to sign those bytes. Used for:

| `kind` | When |
|--------|------|
| `arrival` | Before appending the arrival attestation (no session yet — see auth below) |
| `departure` | After cosign flow, before appending departure |
| `heartbeat` | After `/door/heartbeat` ack, before appending the soulchain heartbeat |

This is how `cosigners` becomes non-empty for arrival/departure/heartbeat without a circular signing payload.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.1`. |
| `door_id` | string | yes | Hosting Door. |
| `epoch` | integer | yes | **Global** epoch supplied by the Wanderer. |
| `kind` | string | yes | `arrival`, `departure`, or `heartbeat`. |
| `core` | string | yes | UTF-8 string equal to the OSP `core` canonical JSON bytes (the exact bytes the Door will sign). Max 64 KiB. |
| `session_pubkey` | string | cond. | Required for `departure` and `heartbeat`. For `arrival`, the new session public key that will appear in the attestation body (Door binds to it). |
| `issued_at` | string | yes | Wanderer timestamp. |
| `sig` | string | yes | For `arrival`: **soul-key** signature over `{ door_id, epoch, kind, core, session_pubkey, issued_at }` (session not valid yet). For `departure` / `heartbeat`: **session-key** signature over the same fields. |

### Response `200`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `door_id` | string | yes | Echo. |
| `epoch` | integer | yes | Echo. |
| `kind` | string | yes | Echo. |
| `door_cosig` | string | yes | Door Ed25519 signature over the raw UTF-8 bytes of `core` (not over a wrapper object). Base64url. |
| `received_at` | string | yes | Door timestamp. |
| `door_sig` | string | yes | Door signature over `{ door_id, epoch, kind, door_cosig, received_at }` (response authenticity). |

The Wanderer places `door_cosig` into the record's `cosigners` array, then soul-signs and appends.

**Core binding:** the Door MUST NOT co-sign arbitrary bytes. After the request signature (and, for arrival, epoch-replay) checks and before any state change, the Door parses `core` and rejects with `core_invalid` unless:

- `core` is a JSON object whose OSP canonical serialization equals the submitted string exactly;
- `type` is `"attestation"` and `body.kind` equals the request `kind`;
- `residency` is `door:<door_id>/epoch:<epoch>` for this Door and the request `epoch`, and `body.door_id` / `body.epoch` equal the request values;
- `body.session_pubkey`, when present, equals the request `session_pubkey`.

### Auth / signing

- **Arrival:** Soul-key `sig` on the request; Door verifies soul pubkey from genesis / prior hello context the operator configured.
- **Departure / heartbeat:** Active session-key `sig`; Door verifies against the session published at arrival for this global `epoch`.
- **`door_cosig`:** MUST verify as Ed25519 over the exact `core` bytes under `door_pubkey`.
- **Response authenticity:** Wanderer MUST reject attest responses whose `door_sig` or `door_cosig` fail verification under `door_pubkey` from a verified hello.

### Arrival epoch monotonicity and supersession

Doors keep an in-memory `lastKnownEpoch` (highest arrival epoch accepted by this Door process; **not durable across restarts** — after restart the Door accepts the first valid arrival again; Wanderers that crash mid-arrival must choose `epoch > hello.active_epoch` when that field is set — see runtime crash-recovery / issue #70).

On `kind: "arrival"` after soul-key and freshness checks:

1. If `lastKnownEpoch` is set and `request.epoch <= lastKnownEpoch`, reject with `epoch_replay` (`409`). This blocks captured arrival replays (including same-epoch re-POST that would reset heartbeat seq).
2. Otherwise, if a **different** epoch's session is currently active, the arrival **supersedes**: retire the old epoch (emit session lifecycle so transports close that epoch's WebSocket clients with `session_end`), reset heartbeat state for the new epoch, and install the new session. An arrival with `epoch` strictly greater than `lastKnownEpoch`, a valid soul-key signature, and a fresh `issued_at` is the sole accepted supersession path (needed for crash recovery when the Door still holds epoch N and the Wanderer re-arrives at N+1).
3. Update `lastKnownEpoch` to the accepted arrival epoch. `lastKnownEpoch` is retained after departure so the same epoch cannot be replayed into a fresh session without a process restart.

### Errors

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `unsupported_kind` | `400` | `kind` not in the allowed set. |
| `core_invalid` | `400` | `core` empty, too large, not valid UTF-8, or not bound to the request (see **Core binding**). |
| `signature_invalid` | `401` | Request `sig` failed. |
| `timestamp_stale` | `401` | `issued_at` outside Door acceptance window (or unparseable). |
| `session_invalid` | `401` | Session required but missing/invalid (`departure` / `heartbeat`). |
| `epoch_mismatch` | `409` | Door's active residency epoch ≠ request `epoch` (when Door has an active session; non-arrival). |
| `epoch_replay` | `409` | Arrival `epoch` ≤ Door `lastKnownEpoch` (replay / non-monotonic). |
| `not_hosting` | `403` | Door refuses to attest (e.g. operator denied arrival). |

---

## `POST /door/cosign`

### Purpose

End-of-residency **host review and co-signing** of candidate memory shards. After distillation, the Wanderer submits shards for operator review, then obtains **Door co-signatures** (`door_cosig`) over the OSP envelope `core` for each approved shard. Those `door_cosig` values are placed in soulchain `memory` records (`cosigners` field per ARCHITECTURE.md §2 and `spec/osp/records.md`).

The flow is **two-phase** on the same path: **review** (approve/reject candidates) then **commit** (sign each approved shard's envelope `core`). This matches OSP verification: `verifyChain` / `verifyRecord` verify every `cosigners[i]` over envelope **core** bytes — not over shard-payload objects.

Phase 1 (review) is invoked during the `depart` flow (T2.5), after the session WebSocket is closed or concurrently with `session_end`. Phase 2 (commit) runs once a quarantined candidate ripens — at a Door advertising `cosign.past_epochs`, typically while the Wanderer's next residency is already live (see **Review retention**).

### Phase 1 — Review

Submit candidate shards for host approval. No soulchain append occurs in this phase.

#### Request (`phase: "review"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.1`. |
| `phase` | string | yes | Must be `"review"`. |
| `door_id` | string | yes | Departing residency. |
| `epoch` | integer | yes | Departing epoch. |
| `session_pubkey` | string | yes | Session key for this epoch. |
| `farewell` | string | no | Short farewell message for the community (≤ 500 chars). |
| `shards` | `CandidateShard[]` | yes | 5–20 candidate shards (distiller output). |
| `issued_at` | string | yes | Wanderer timestamp. |
| `sig` | string | yes | Session-key signature over all other request fields. |

#### `CandidateShard`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shard_id` | string | yes | Unique in this request. |
| `text` | string | yes | First-person memory text, ≤ 500 chars, no PII (immune screen applies before submit). |
| `tags` | string[] | no | Optional topical tags for host review. |

#### Response `200` (review)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phase` | string | yes | `"review"`. |
| `door_id` | string | yes | Echo. |
| `epoch` | integer | yes | Echo. |
| `decisions` | `ReviewDecision[]` | yes | One entry per submitted `shard_id`. |
| `received_at` | string | yes | Door timestamp. |
| `door_sig` | string | yes | Door signature over `{ door_id, epoch, phase, decisions, received_at }`. |

#### `ReviewDecision`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shard_id` | string | yes | Matches request. |
| `status` | string | yes | `approved` or `rejected`. |
| `reason` | string | no | Host-facing reason (required when `rejected`; omit payload reproduction). |
| `host_audit_sig` | string | no | Optional Door signature over `{ shard_id, text, door_id, epoch }` (`text` from the submitted shard). **MUST NOT** be placed in soulchain `cosigners` — it is a host-audit artifact only, not an OSP envelope co-signature. |

The Wanderer MUST NOT append rejected shards to the soulchain. Quarantine lifecycle (`memory.candidate` → `memory.shard`) is T3.2 and out of scope for v0.1 Ghost; in T2.5, only **approved** shards proceed to Phase 2 and are appended as committed `memory` records.

### Phase 2 — Commit

For each **approved** shard from Phase 1, the Wanderer builds the unsigned `memory` envelope (`cosigners` empty, no `sig`), computes the OSP **`core`** bytes (canonical JSON with `cosigners` and `sig` omitted — same rules as `POST /door/attest`), and requests a `door_cosig` over those raw bytes.

Under `osp/0.2`, the commit-phase `core` body carries `text_cid` / `text_hash` (and optional `journal_cid` / `journal_hash`) instead of inline prose — see `spec/osp/records.md`. Phase 1 **review** still ships plaintext `CandidateShard.text` for host review; only the commit envelope references side blobs.

#### Request (`phase: "commit"`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.1`. |
| `phase` | string | yes | Must be `"commit"`. |
| `door_id` | string | yes | Reviewed residency's Door. |
| `epoch` | integer | yes | Reviewed epoch (the epoch of the Phase 1 review; may be a past epoch — see **Review retention**). |
| `session_pubkey` | string | yes | Session key of the reviewed epoch (the key that signed its review). |
| `shard_id` | string | yes | `shard_id` from Phase 1 (must have been `approved`). |
| `core` | string | yes | UTF-8 string equal to the OSP `core` canonical JSON bytes for the unsigned `memory` envelope (the exact bytes the Door will sign). Max 64 KiB. |
| `issued_at` | string | yes | Wanderer timestamp. |
| `sig` | string | yes | Session-key signature over all other request fields. |

#### Response `200` (commit)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phase` | string | yes | `"commit"`. |
| `door_id` | string | yes | Echo. |
| `epoch` | integer | yes | Echo. |
| `shard_id` | string | yes | Echo. |
| `door_cosig` | string | yes | Door Ed25519 signature over the raw UTF-8 bytes of `core` (not over a wrapper object). Base64url. Same semantics as `POST /door/attest` `door_cosig`. |
| `received_at` | string | yes | Door timestamp. |
| `door_sig` | string | yes | Door signature over `{ door_id, epoch, phase, shard_id, door_cosig, received_at }` (response authenticity). |

The Wanderer places `door_cosig` into the record's `cosigners` array (typically a single element), soul-signs, and appends. **Only** this `door_cosig` value belongs in `cosigners`; Phase 1 `host_audit_sig` (if present) is never copied there.

**Commit binding:** the Door co-signs only the envelope of the shard the host reviewed. It rejects with `shard_invalid` unless `core` is canonical JSON (as for `/door/attest`), `type` is `"memory"`, `body.kind` is `"shard"`, `residency` is `door:<door_id>/epoch:<epoch>` of the reviewed epoch, `seq` is a positive integer, and the body references the reviewed `CandidateShard.text`:

- `osp/0.2`: `body.text_hash` MUST equal the base64url sha2-256 of the shard-text side blob for the reviewed text (`encodeShardTextBlob`, i.e. the canonical JSON string), `body.text_cid` (when present) MUST bind the same digest, and inline `body.text` MUST be absent;
- legacy inline text: `body.text` MUST equal the reviewed text exactly.

**Single-use approval:** each approved `shard_id` yields one co-signature per chain position. A further commit for the same `shard_id` is accepted only when its `core` `seq` is strictly greater than every `seq` already co-signed for it (the runtime re-requests after the chain head moved); otherwise `shard_not_approved`. **Idempotent retry:** a commit for the same `shard_id` at the **same** `seq` as its latest co-signature with a **byte-identical** `core` (the Wanderer lost the reply) MUST return the stored response (same `door_cosig`) instead of `shard_not_approved`; it is a fresh, session-signed request like any other. Wanderers MUST therefore re-send the exact `core` they prepared for a chain position (same `distilled_at`, same side-blob refs) when retrying it; the reference runtime keeps prepared cores in memory per `(candidate, seq, prev)`.

### Auth / signing

- **Review request:** Session-key `sig` for the departing epoch.
- **Review response:** `door_sig` over the decision list; optional per-shard `host_audit_sig` (never soulchain `cosigners`).
- **Commit request:** `sig` under the session key of the **reviewed** epoch (`session_pubkey` MUST equal the session key bound at that epoch's review; the active session is irrelevant); Door MUST reject `shard_id` not approved in Phase 1 for this `(door_id, epoch)`, a `core` that fails **Commit binding**, and a reused approval (**Single-use approval**; an **Idempotent retry** is not reuse).
- **Review identity:** two review requests are the **same review** when they have the same `door_id`, `epoch`, `session_pubkey` and the same set of `{ shard_id, text }` pairs (order-insensitive). `issued_at` and `sig` are not part of the identity — a retrying Wanderer re-signs with a fresh `issued_at`.
- **Concurrent review:** at most one review may be in flight. A Door with asynchronous host review MUST NOT re-post shards for a retry: a fresh, correctly session-signed request for the same review joins the pending review and receives its response; any other review request while one is pending is rejected with `review_pending`.
- **Completed review:** once an epoch's review completed, a fresh, correctly session-signed request for the same review MUST receive the stored review response (same `decisions`, `received_at`, `door_sig`) — the Wanderer lost the reply. Any other review for that epoch is `epoch_closed`. Replay is only owed until the Door accepts a newer arrival: afterwards every review for the past epoch (including a retry of its completed review) is `epoch_closed` — reviews exist only for the active (or just-departed) epoch. A Door MAY also answer `epoch_closed` to a retry after a restart (the reference Door does not persist the review identity, which embeds rejected shard text).
- **Review latency:** a review response blocks on human review. The Wanderer's HTTP client uses an explicit review-call timeout (reference: 290 s, below Node `fetch`'s 300 s headers timeout) and a Door SHOULD bound host review well below it (door-discord default `DISCORD_REVIEW_TIMEOUT_MS` = 240 s; timeout rejects). A client timeout is recoverable by retrying the same review (join / stored response above).
- **Commit response:** `door_cosig` MUST verify as Ed25519 over the exact `core` bytes under `door_pubkey` (same verification as `/door/attest`).

### Review retention (`cosign.past_epochs`)

Quarantine (`spec/osp/records.md`) commits a shard only after its candidate ripened (reference window: 24 h), and with one Door the Wanderer's next residency is a new arrival at that same Door. A Door advertising `cosign.past_epochs`:

- MUST NOT discard a completed review on arrival, departure or supersession. It keeps, per reviewed epoch: the review's `session_pubkey`, the approved `{ shard_id, text }` pairs, and the **Single-use approval** records (latest co-signed `seq` + `core` + response per `shard_id`). Rejected shard text need not (and in the reference implementation does not) outlive the review.
- MUST accept a commit for any retained epoch, including a past epoch while a newer epoch is active, authenticated by that epoch's `session_pubkey`, with every other rule unchanged (**Commit binding** to `door:<door_id>/epoch:<reviewed epoch>`, approved `text`, **Single-use approval**, **Idempotent retry**).
- MAY evict retained reviews, but only by a documented bound, which SHOULD comfortably exceed the Wanderer's quarantine window (and the residencies that fit in it) — a candidate whose review is evicted before it ripens is stranded. Reference implementation (`door-sdk`): the latest **16** reviewed epochs and at most **7 days** after review completion, whichever evicts first (configurable; door-discord: `DOOR_COSIGN_RETAIN_EPOCHS`, `DOOR_COSIGN_RETAIN_MS`).
- SHOULD persist retained reviews durably so they survive a Door restart (door-discord: `DOOR_STATE_DIR`; atomic write + fsync). A durable Door MUST persist a new **Single-use approval** record before returning its `door_cosig`; if it cannot, it MUST NOT return the co-signature (`internal_error`, `500`).
- MUST answer a commit for an epoch below the highest arrival epoch it accepted, with no retained review, with `review_not_retained` (`410`): the review never happened at this Door, was evicted, or was lost in a non-durable restart. It is permanent — the Wanderer stops retrying that candidate (it stays `memory.candidate`). A commit for the active epoch (or a later one) before its review completed remains `review_pending`.

**Security.** A past epoch's session key was retired at departure, yet still authenticates commits for that epoch. That is acceptable because the commit grants nothing the host did not already approve: the Door co-signs only `memory.shard` cores bound to that epoch's residency whose text equals a shard the host **approved** in that epoch's review, once per chain position; and a co-signature is useless without a soul-key signature to append the record. A leaked retired session key can therefore at most obtain co-signatures for already approved memories of its own epoch — never for new text, another epoch, an attestation, or a session frame (those still require the **active** session). Session keys are derived from the soul key per `(door_id, epoch)`, so the Wanderer can re-derive a past epoch's key for its commits without retaining extra secrets.

A Door that does not advertise `cosign.past_epochs` MAY discard the review on the next arrival; the Wanderer then commits only between departure and its next arrival at that Door (the reference runtime refuses quarantine windows over 1 h in that case).

### Errors

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `unsupported_phase` | `400` | `phase` not `"review"` or `"commit"`. |
| `session_invalid` | `401` | Session not valid for cosign. |
| `signature_invalid` | `401` | Request `sig` failed. |
| `epoch_closed` | `409` | Cosign review already completed for this epoch and the request is not a retry of that review (see **Completed review**). |
| `shard_not_approved` | `403` | Commit `shard_id` was not approved in Phase 1, or its approval was already used at this or a later `seq` (other than an **Idempotent retry** of the latest one). |
| `shard_count` | `422` | Review: fewer than 5 or more than 20 shards. |
| `shard_invalid` | `422` | Shard text over limit, missing `shard_id`, or invalid / unbound `core` (see **Commit binding**). |
| `review_pending` | `503` | Host review not complete, or a different review is already in flight (Door MAY use async review; Wanderer retries Phase 1). |
| `review_not_retained` | `410` | `cosign.past_epochs`: commit for a past epoch whose review this Door does not retain (never reviewed here, evicted, or lost in a restart). Permanent; do not retry. |
| `internal_error` | `500` | Door failed to persist review / single-use state; no co-signature was issued (retry later). |

---

## Versioning

- Spec version `door/0.1` is recorded in `protocol_version` fields and in soulchain `residency` / attestation metadata where applicable.
- Breaking wire changes require a new spec version and migration vectors; do not silently extend v0.1 required fields.

---

## Implementer checklist (`door-sdk`, T4.1)

1. Typed request/response/frame types for all five endpoints (`hello`, `session`, `heartbeat`, `attest`, `cosign`).
2. Door identity keypair generation and `sig` / `door_sig` / `door_cosig` helpers.
3. OSP `core` cosigning for `/door/attest` and `/door/cosign` commit phase (sign raw `core` bytes); `/door/cosign` review phase returns approve/reject only — optional `host_audit_sig` is separate from soulchain `cosigners`.
4. In-process transport implementing the same shapes (no network).
5. WebSocket transport for `/door/session`.
6. Contract tests shared with runtime integration suite (T2.4, T2.5).
