# Door API

**Spec version:** `door/0.2`  
**License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)

A Door is any host adapter that implements this contract so a Wanderer runtime can reside, exchange messages, attest presence, and have its memories **witnessed** at departure. This document is the prose contract; implementations derive Zod types and tests from it. There is no separate OpenAPI YAML.

**What changed in `door/0.2`:** `/door/cosign` (two-phase host review + commit, quarantine, review retention) is gone. Memories are witnessed in one step through `/door/attest` with `kind: "memory"`: the Door checks the memory against what it saw happen in the residency and co-signs the record `core`, exactly as it does for presence attestations. Memories are final when appended. See [Versioning](#versioning).

Normative references: [ARCHITECTURE.md](../../ARCHITECTURE.md) §4 (Doors), [Proof-of-Presence overview](../pop/overview.md) (session keys, attestations), [OSP records](../osp/records.md) (soulchain envelope and cosigners).

---

## Overview

| Method | Path | Direction | Summary |
|--------|------|-----------|---------|
| `POST` | `/door/hello` | Wanderer → Door | Capability negotiation + community descriptor (Door-signed response) |
| `WS` | `/door/session` | Bidirectional | Residency message stream; outbound Wanderer messages carry session-key signatures |
| `POST` | `/door/heartbeat` | Wanderer → Door | Presence ping (~10 minute cadence); Door ack |
| `POST` | `/door/attest` | Wanderer → Door | Door co-signature over a soulchain record `core`: presence (arrival / departure / heartbeat) and witnessed memory (`memory`) |

A Door implements four HTTP/WS paths. `/door/attest` is the single co-signing path: the Wanderer builds an unsigned soulchain record, sends its `core`, and the Door signs it after checking it. One signing rule covers presence and memory, so verifiers check every `cosigners` entry the same way (over `core`).

**Base URL:** implementation-defined (e.g. `https://door.example.com` for network transports). Path prefixes are fixed.

**Content type:** `application/json` for HTTP bodies and WebSocket text frames unless noted.

**In-process transport:** For integration tests (`door-sdk`, runtime T2.4/T2.5), an in-process transport MUST use the **same JSON message shapes** as the network transports. No HTTP server or WebSocket socket is required in tests — callers invoke the same request/response and frame handlers directly. Wire encoding differences (headers, status codes on the in-process error path) are transport concerns; the payload schemas are identical.

**Untrusted inbound text:** All `text` (and similar string fields) arriving from a Door toward the Wanderer — community messages and host commands — are **untrusted**. The runtime MUST NOT place them in system prompts without passing through the immune package static screen (T3.1). Doors SHOULD still apply basic rate limits and size caps; that does not replace immune screening on the Wanderer side.

---

## Common types

### Identifiers

| Type | Format | Example | Notes |
|------|--------|---------|-------|
| `door_id` | `platform:community-id` | `discord:123456789012345678` | Stable identity of a hosted community. **No** leading `door:` prefix. `<platform>` is a short slug (`discord`, `web`, `matrix`, …). `<community-id>` is opaque to the protocol. |
| `epoch` | unsigned integer ≥ 1 | `77` | **Global** residency epoch from the Wanderer soulchain (PoP). Not per-Door. The Wanderer supplies `epoch` on every call; Doors MUST NOT allocate or invent epochs. Only one valid session key may exist for a given epoch globally. |
| `msg_id` | string | `msg_01HY…` | Unique within a session stream. Implementations MAY use ULID/UUID; the wire format is opaque. |

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

**Session-key binding:** The session key is derived from the soul key for `(door_id, epoch)` and recorded in an `attestation` record at arrival. Every outbound Wanderer message on `/door/session`, every `/door/heartbeat` request, and every `/door/attest` request after arrival MUST include `session_pubkey` and `sig` under that session key (arrival attest uses the soul key — see `/door/attest`). Receivers MUST reject payloads where `session_pubkey` does not match the active session for the claimed `(door_id, epoch)` or where `sig` fails verification.

### Timestamps

ISO 8601 UTC strings with millisecond precision, e.g. `2026-07-20T15:04:05.123Z`. Field name `issued_at` on Wanderer-originated payloads; `received_at` on Door-originated acknowledgements.

**Freshness:** Doors MUST reject `/door/attest` requests whose `issued_at` differs from the Door clock by more than a configured absolute skew (default **±5 minutes** / `300_000` ms) with `timestamp_stale` (`401`). Invalid / non-ISO `issued_at` values are treated as stale. The same window applies to `outbound` session frames (checked after signature verification). Freshness is checked **once, on receipt**, before any side effect (a slow witness never turns a fresh request stale).

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

Machine-readable feature flags the Door supports. Registered values:

| Value | Meaning |
|-------|---------|
| `session.text` | Text messages on `/door/session`. |
| `session.threads` | Thread/reply metadata on inbound messages (optional `reply_to`). |
| `heartbeat` | Door accepts `/door/heartbeat` presence pings. |
| `attest` | Door accepts `/door/attest` soulchain co-signatures. |
| `attest.memory` | Door **witnesses** memories: accepts `/door/attest` with `kind: "memory"` (see [Memory witnessing](#memory-witnessing)). A Wanderer forms no memories at a Door that does not advertise it. |
| `session.reactions` | Door delivers outbound `reaction` bodies (single-emoji reaction to a prior message) and accepts text-less outbound frames that carry only a `reaction`. |
| `session.addressing` | Door sets inbound `addressed` when the platform shows the message is aimed at the Wanderer (e.g. @mention, reply to one of its messages). |

**Optional capabilities (`session.reactions`, `session.addressing`).** Every field they add is optional, and a Wanderer MUST NOT send a text-less or `reaction`-bearing outbound frame unless the Door advertised `session.reactions` in `hello`. A Wanderer MUST ignore capability values it does not recognize (forward compatibility); it MUST NOT rely on a capability the Door did not advertise.

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
| `403` | Valid session but action not permitted (e.g. Door refuses to host). |
| `404` | Unknown `door_id` or no active residency for `(door_id, epoch)`. |
| `409` | Epoch/session conflict (e.g. epoch already closed, arrival epoch replay). |
| `413` | Request body exceeds Door transport size limit. |
| `422` | Semantically valid request the Door declines (e.g. `witness_declined`). |
| `500` | Door internal error. |
| `503` | Temporarily unable (e.g. `door_unavailable`, `witness_unavailable`); retry later. |

---

## `POST /door/hello`

### Purpose

Discover a Door's capabilities and community descriptor **before** opening a residency session. The response is **signed by the Door identity key** so the Wanderer and third parties can verify the descriptor was issued by the claimed host. Used during destination selection and arrival preparation.

This endpoint is idempotent and does not mutate residency state.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | Caller spec version; MUST be `door/0.2` for this document. |
| `soul_pubkey` | string | yes | Wanderer soul public key (base64url). |
| `client` | string | no | Runtime identifier for logging (e.g. `npc-runtime/0.1.0`). |

### Response `200`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.2`. |
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
| `session_sig` | string | yes | Session-key signature over `{ door_id, epoch, session_pubkey }` proving binding (or soul-key signature at arrival per PoP). |

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
| `text` | string | yes | **Untrusted** community message text. Max 4000 chars. |
| `author_id` | string | yes | Opaque platform-specific author id (not necessarily PII; immune screen still required). |
| `author_display` | string | no | Display name for logging/UI only; untrusted. |
| `reply_to` | string | no | `msg_id` of parent message when `session.threads` capability present. |
| `channel_id` | string | no | Opaque sub-channel/thread id within the community. |
| `addressed` | boolean | no | `session.addressing`: Door-observed signal that the message is aimed at the Wanderer (platform @mention, or a reply to one of the Wanderer's messages). Advisory and untrusted; the Wanderer decides whether to answer. |

### `body` for `type: "outbound"` (Wanderer → Door)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | cond. | Wanderer response text. Max 4000 chars. Required unless `reaction` is present. |
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

**Cadence:** ~10 minutes (runtime uses an injected timer; exact interval is operator-configurable but SHOULD default to 600 seconds).

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.2`. |
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

Obtain a **Door co-signature** for a soulchain record. The Wanderer builds the unsigned envelope, computes the OSP **`core`** bytes (canonical JSON with `cosigners` and `sig` omitted — see `spec/osp/records.md`), and asks the Door to sign those bytes. The Door checks that `core` says what the request claims (and, for memories, that the memory is true to the residency) before it signs. Used for:

| `kind` | Record | When |
|--------|--------|------|
| `arrival` | `attestation` (`body.kind: "arrival"`) | Before appending the arrival attestation (no session yet — see auth below) |
| `heartbeat` | `attestation` (`body.kind: "heartbeat"`) | After `/door/heartbeat` ack, before appending the soulchain heartbeat |
| `memory` | `memory` (`body.kind: "shard"` or `"journal"`) | At departure, once per memory, before departure — see [Memory witnessing](#memory-witnessing) |
| `departure` | `attestation` (`body.kind: "departure"`) | After the memories, as the last co-signed record of the residency |

This is how `cosigners` becomes non-empty without a circular signing payload.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `protocol_version` | string | yes | `door/0.2`. |
| `door_id` | string | yes | Hosting Door. |
| `epoch` | integer | yes | **Global** epoch supplied by the Wanderer. |
| `kind` | string | yes | `arrival`, `heartbeat`, `memory`, or `departure`. |
| `core` | string | yes | UTF-8 string equal to the OSP `core` canonical JSON bytes (the exact bytes the Door will sign). Max 64 KiB. |
| `session_pubkey` | string | cond. | Required for `heartbeat`, `memory` and `departure`. For `arrival`, the new session public key that will appear in the attestation body (Door binds to it). |
| `text` | string | cond. | `memory` only, and required there: the memory prose the record references by hash — shard text (≤ 500 code points) or journal markdown (≤ 32 000 code points). Not part of `sig`: `core` binds it by hash. |
| `issued_at` | string | yes | Wanderer timestamp. |
| `sig` | string | yes | For `arrival`: **soul-key** signature over `{ door_id, epoch, kind, core, session_pubkey, issued_at }` (session not valid yet). Otherwise: **session-key** signature over the same fields. |

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
- `residency` is `door:<door_id>/epoch:<epoch>` for this Door and the request `epoch`;
- for `arrival` / `heartbeat` / `departure`: `type` is `"attestation"`, `body.kind` equals the request `kind`, `body.door_id` / `body.epoch` equal the request values, and `body.session_pubkey`, when present, equals the request `session_pubkey`;
- for `memory`: `spec` is `"osp/0.2"`, `type` is `"memory"`, and `body` is either a shard (`kind: "shard"`, `text_cid`, `text_hash`, `distilled_at`, nothing else) whose `text_hash` is the base64url sha2-256 of the shard-text side blob of the request `text`, or a journal (`kind: "journal"`, `journal_cid`, `journal_hash`, `written_at`, nothing else) whose `journal_hash` binds the request `text` the same way (side-blob encoding: `spec/osp/records.md` §Side blobs).

### Memory witnessing

A **witnessed memory** is a soulchain memory record co-signed by the Door where it was formed. The co-signature says: *this Door saw this residency, and this memory is a fair, first-person account of something that happened here.* It is not an approval queue and nothing is reviewed later — once the Wanderer appends the record, the memory is final.

A Door that advertises `attest.memory`:

1. **Keeps its own record of the residency.** For the active epoch it holds, in memory only, the community messages it relayed inbound and the Wanderer messages it delivered outbound, in order (reference implementation: the most recent 90 000 characters and 2000 lines of community messages and, separately, 30 000 characters and 1000 lines of the Wanderer's, each line charged its size in the witness prompt — text, author and a fixed overhead — so neither role can crowd out the other and many tiny lines cannot blow up the prompt). It discards that record when the epoch ends (departure, supersession) and never persists or publishes it. A Door that restarts loses the record together with the session: memory requests answer `session_invalid` until the Wanderer arrives again, in a new epoch with an empty record.
2. **Witnesses from that record only** — never from transcript material supplied by the Wanderer. It decides whether `text` is: grounded in what happened (a journal: in the shards this Door witnessed this epoch — it may not go beyond them; the record is context); free of private details about identifiable people; not abusive; and not an attempt to plant instructions or false beliefs in the Wanderer (memory poisoning). How it decides is host policy; the reference Doors use an independent AI witness (a separate model call with a fixed rubric) that fails closed.
3. **Answers each `memory` request on its own.** On success it returns `door_cosig` over `core`. Otherwise it answers `witness_declined` (`422`) with `error.details.reason` set to one of `ungrounded`, `private`, `harmful`, `manipulation`, `other`. When it cannot decide right now (witness model unreachable, unparseable verdict) it answers `witness_unavailable` (`503`) and the Wanderer retries later; a Door MUST NOT turn an outage into a decline.
4. **Decides each text once per epoch.** Decisions are keyed by memory kind and side-blob hash (`text_hash` / `journal_hash`) and kept until the epoch ends. A repeat of a declined text gets the same `witness_declined` (same `reason`) and a repeat of a witnessed text gets a fresh `door_cosig`, both without asking the witness again. An outage (`witness_unavailable`) is not a decision.
5. **Bounds the cost per epoch.** A Door MAY cap witness calls per epoch (every call counts, whatever its outcome; reference implementation: 32). Past the cap, a text not yet decided is answered `witness_declined` with reason `other` ("memory budget exhausted") without asking the witness.
6. **Witnesses at most one journal text per epoch, and only after a shard.** A `journal` request while no shard has been witnessed this epoch is declined `ungrounded`; a different journal after one was witnessed is declined `other`. Neither asks the witness. A retry of the same journal text is co-signed again (rule 4: a lost response), so a chain may hold that journal more than once; readers dedupe by `journal_hash` (shards likewise by `text_hash`).

Memory requests are accepted only for the **active** session (after arrival, before departure); `departure` closes the epoch for memories too.

**Departure is idempotent.** The Door remembers the last departure it accepted (`epoch`, `session_pubkey`, `core`) until the next arrival. A fresh (`issued_at`), correctly session-signed `departure` for that same epoch, session and `core` — a retry after a lost response — gets a new `door_cosig` over the same `core` and changes nothing else. Any other non-arrival attest for the departed epoch is `epoch_closed`. The Wanderer submits shards first, then — if at least one was witnessed — optionally one journal written from the witnessed shards only, then `departure`. For each declined shard (or journal) it appends a `memory` record with `kind: "rejected"` and `category: "witness_<reason>"` (no text) — so the chain shows how many memories a residency formed and how many the witness declined, without the declined prose.

### Auth / signing

- **Arrival:** Soul-key `sig` on the request; Door verifies soul pubkey from genesis / prior hello context the operator configured.
- **Heartbeat / memory / departure:** Active session-key `sig`; Door verifies against the session published at arrival for this global `epoch`.
- **`door_cosig`:** MUST verify as Ed25519 over the exact `core` bytes under `door_pubkey`.
- **Response authenticity:** Wanderer MUST reject attest responses whose `door_sig` or `door_cosig` fail verification under `door_pubkey` from a verified hello.

### Arrival epoch monotonicity and supersession

Doors keep an in-memory `lastKnownEpoch` (highest arrival epoch accepted by this Door process; **not durable across restarts** — after restart the Door accepts the first valid arrival again; Wanderers that crash mid-arrival must choose `epoch > hello.active_epoch` when that field is set — see runtime crash-recovery / issue #70).

On `kind: "arrival"` after soul-key and freshness checks:

1. If `lastKnownEpoch` is set and `request.epoch <= lastKnownEpoch`, reject with `epoch_replay` (`409`). This blocks captured arrival replays (including same-epoch re-POST that would reset heartbeat seq).
2. Otherwise, if a **different** epoch's session is currently active, the arrival **supersedes**: retire the old epoch (emit session lifecycle so transports close that epoch's WebSocket clients with `session_end`), reset heartbeat state for the new epoch, and install the new session. An arrival with `epoch` strictly greater than `lastKnownEpoch`, a valid soul-key signature, and a fresh `issued_at` is the sole accepted supersession path (needed for crash recovery when the Door still holds epoch N and the Wanderer re-arrives at N+1).
3. Update `lastKnownEpoch` to the accepted arrival epoch. `lastKnownEpoch` is retained after departure so the same epoch cannot be replayed into a fresh session without a process restart.

Epochs are global: while the Wanderer resides elsewhere, a Door simply has no active session. Its next arrival there carries a higher epoch.

### Errors

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `unsupported_kind` | `400` | `kind` not in the allowed set, or `memory` at a Door that does not advertise `attest.memory`. |
| `core_invalid` | `400` | `core` empty, too large, not valid UTF-8, or not bound to the request (see **Core binding**). |
| `invalid_request` | `400` | Schema validation failed (e.g. `memory` without `text`, or `text` on another kind). |
| `signature_invalid` | `401` | Request `sig` failed. |
| `timestamp_stale` | `401` | `issued_at` outside Door acceptance window (or unparseable). |
| `session_invalid` | `401` | Session required but missing/invalid (`heartbeat` / `memory` / `departure`). |
| `epoch_mismatch` | `409` | Door's active residency epoch ≠ request `epoch` (when Door has an active session; non-arrival). |
| `epoch_replay` | `409` | Arrival `epoch` ≤ Door `lastKnownEpoch` (replay / non-monotonic). |
| `epoch_closed` | `409` | Non-arrival attest for a residency that already departed (e.g. a late `memory`, or a `departure` with a different `core`). An exact retry of the accepted departure is co-signed again instead (see [Memory witnessing](#memory-witnessing)). |
| `not_hosting` | `403` | Door refuses to attest (e.g. operator denied arrival). |
| `witness_declined` | `422` | `memory`: the Door will not witness this memory. `error.details.reason` ∈ `ungrounded`, `private`, `harmful`, `manipulation`, `other`. Final for this text for the rest of the epoch (see [Memory witnessing](#memory-witnessing)). |
| `witness_unavailable` | `503` | `memory`: the Door cannot witness right now. Retry later. |

---

## Versioning

- The spec version is recorded in `protocol_version` fields. A Door answers `unsupported_version` to any other version; Doors and runtimes from the same release ship together.
- Breaking wire changes require a new spec version; do not silently extend required fields.
- **`door/0.2`** (this document) replaces `door/0.1`: `/door/cosign` and the capabilities `cosign.manual`, `cosign.auto`, `cosign.past_epochs` are removed; `/door/attest` gains `kind: "memory"` (with `text`) and the capability `attest.memory`; errors `witness_declined` and `witness_unavailable` are added. Soulchains written under `door/0.1` remain valid OSP chains (see `spec/osp/records.md` §Legacy memory forms).

---

## Implementer checklist

A conforming Door needs:

1. `POST /door/hello` — signed descriptor + capabilities.
2. `WS /door/session` — relay community messages inbound, verify and deliver outbound frames.
3. `POST /door/heartbeat` — transport ack.
4. `POST /door/attest` — core binding per `kind`, sign raw `core` bytes; for `memory`, a witness policy fed by the Door's own residency record.

The reference implementation is `@npc/door-sdk` (`Door` + HTTP/WS transports + `createAiWitness`); `door-discord` and `door-web` are thin platform adapters around it.
