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
| `POST` | `/door/heartbeat` | Wanderer → Door | Presence attestation (~10 minute cadence) |
| `POST` | `/door/cosign` | Wanderer → Door | Host review + co-sign candidate memory shards at departure |

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
| `epoch` | unsigned integer ≥ 1 | `77` | Residency counter at this `door_id`. Increments on each new arrival. A Wanderer MUST NOT hold a valid session key for the same `(door_id, epoch)` from two operators simultaneously (PoP). |
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

**Session-key binding (v0.1):** The session key is derived from the soul key for `(door_id, epoch)` and recorded in an `attestation` record at arrival. Every outbound Wanderer message on `/door/session`, every `/door/heartbeat` request, and every `/door/cosign` request MUST include `session_pubkey` and `sig` under that session key. Receivers MUST reject payloads where `session_pubkey` does not match the active session for the claimed `(door_id, epoch)` or where `sig` fails verification.

### Timestamps

ISO 8601 UTC strings with millisecond precision, e.g. `2026-07-20T15:04:05.123Z`. Field name `issued_at` on Wanderer-originated payloads; `received_at` on Door-originated acknowledgements.

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
| `heartbeat` | Door accepts `/door/heartbeat` attestations. |
| `cosign.manual` | Host manually approves shards on `/door/cosign` (v0.1 default). |
| `cosign.auto` | Door may auto-approve shards matching host policy (not required in v0.1). |

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
| `409` | Epoch/session conflict (e.g. epoch already closed). |
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
| `epoch_next` | integer | yes | Epoch number that **would** be assigned on the next successful arrival. |
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

Door MUST reject the connection with WebSocket close code `4401` if session binding fails, or send an `error` control frame (below) before closing.

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

### `body` for `type: "outbound"` (Wanderer → Door)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Wanderer response text. Max 4000 chars in v0.1. |
| `reply_to` | string | no | `msg_id` of inbound message being answered. |
| `channel_id` | string | no | Route reply to the same channel as inbound. |

**Signing:** `sig` MUST be a session-key signature over the full frame excluding `sig`, with `type` = `outbound`. Door MUST verify before delivering to the community.

### `body` for `type: "control"`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | `ping`, `pong`, `session_end`, or `backpressure`. |
| `reason` | string | no | Human-readable detail for `session_end` / `backpressure`. |

Either party MAY send `ping`; the other MUST respond with `pong`. Door sends `session_end` when the host closes the residency (operator action, platform disconnect).

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

Door SHOULD persist or forward attestations for Atlas/soulchain correlation (v0.1: optional local log; future tasks may require soulchain `attestation` records).

### Auth / signing

- **Request:** Session-key `sig` required; MUST match active residency.
- **Response:** `door_sig` required so the attestation is host-backed.

### Errors

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `session_invalid` | `401` | No active session for `(door_id, epoch)`. |
| `signature_invalid` | `401` | `sig` failed verification. |
| `epoch_closed` | `409` | Residency already departed. |
| `seq_replay` | `409` | `seq` not greater than last accepted (if Door tracks). |

---

## `POST /door/cosign`

### Purpose

End-of-residency **host review** of candidate memory shards. After distillation, the Wanderer submits shards; the Door operator approves or rejects each; approved shards receive a **Door co-signature** (`door_cosig`) used in soulchain `memory` records (`cosigners` field per ARCHITECTURE.md §2).

Typically invoked once per residency during the `depart` flow (T2.5), after the session WebSocket is closed or concurrently with `session_end`.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.1`. |
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

### Response `200`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `door_id` | string | yes | Echo. |
| `epoch` | integer | yes | Echo. |
| `decisions` | `CosignDecision[]` | yes | One entry per submitted `shard_id`. |
| `received_at` | string | yes | Door timestamp. |
| `door_sig` | string | yes | Door signature over `{ door_id, epoch, decisions, received_at }`. |

#### `CosignDecision`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `shard_id` | string | yes | Matches request. |
| `status` | string | yes | `approved` or `rejected`. |
| `reason` | string | no | Host-facing reason (required when `rejected`; omit payload reproduction). |
| `door_cosig` | string | yes when `approved` | Door signature over `{ shard_id, text, door_id, epoch }` (text from the approved shard). Absent when `rejected`. |

The Wanderer MUST NOT commit rejected shards to the soulchain. Approved shards are committed as `memory` records with `cosigners` containing `door_cosig` values.

### Auth / signing

- **Request:** Session-key `sig` for the departing epoch.
- **Response:** `door_sig` over the decision list; per-shard `door_cosig` for approvals.

### Errors

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `session_invalid` | `401` | Session not valid for cosign. |
| `signature_invalid` | `401` | Request `sig` failed. |
| `epoch_closed` | `409` | Cosign already completed for this epoch. |
| `shard_count` | `422` | Fewer than 5 or more than 20 shards. |
| `shard_invalid` | `422` | Shard text over limit or missing `shard_id`. |
| `review_pending` | `503` | Host review not complete (Door MAY use async review; Wanderer retries). |

---

## Versioning

- Spec version `door/0.1` is recorded in `protocol_version` fields and in soulchain `residency` / attestation metadata where applicable.
- Breaking wire changes require a new spec version and migration vectors; do not silently extend v0.1 required fields.

---

## Implementer checklist (`door-sdk`, T4.1)

1. Typed request/response/frame types for all four endpoints.
2. Door identity keypair generation and `sig` / `door_sig` / `door_cosig` helpers.
3. In-process transport implementing the same shapes (no network).
4. WebSocket transport for `/door/session`.
5. Contract tests shared with runtime integration suite (T2.4, T2.5).
