# Open Soul Protocol — Soulchain Records

| | |
|---|---|
| **Version** | `osp/0.1`, `osp/0.2` |
| **License** | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| **Status** | Draft — v0.1 "Ghost" (local inline memory); v0.2 side-blob memory + tombstones |

This document is the authoritative prose schema for OSP soulchain records at versions `osp/0.1` and `osp/0.2`. When this spec and implementation disagree, **this spec wins**. Conformance test vectors are defined separately (see [Verification](#verification); vectors in `spec/osp/vectors/`).

---

## Overview

The soulchain is an append-only, hash-linked log of signed records. Each record is content-addressed (CID) and cryptographically chained to its predecessor. Together the chain constitutes the Wanderer's identity: genesis charter, memories, drift, decisions, attestations, and (in later milestones) transactions.

A conforming runtime loads the chain head, verifies integrity, and composes the current self from genesis + drift + witnessed memory shards. Raw conversation transcripts are never stored on the chain.

---

## Record envelope

Every soulchain record is a JSON object with the following top-level fields. The envelope is signed as a unit (see [Canonical serialization](#canonical-serialization)).

| Field | Type | Required | Constraints |
|---|---|---|---|
| `spec` | string | yes | Must be exactly `"osp/0.1"` or `"osp/0.2"`. **Every record in a chain MUST share the same `spec` value** (homogeneous chains). Mixed versions are invalid — `verifyChain` reports `schema_violation`. Identifies the schema version independently of package semver (see ENGINEERING.md D6). |
| `seq` | unsigned integer | yes | Monotonic sequence number. **Genesis uses `seq: 0`.** Each subsequent record increments by exactly 1 (`1`, `2`, `3`, …). No gaps, no reuse. |
| `prev` | string \| null | yes | When present, must be a CIDv1 base32 dag-json sha2-256 string (`bagu…`) as defined under [CIDs](#cids). CID of the previous record. **`null` only on the genesis record** (`seq: 0`). All other records must contain a valid CID string equal to the CID of record `seq - 1`. |
| `type` | string | yes | One of: `genesis`, `memory`, `drift`, `decision`, `transaction`, `attestation`, `sleep`, `tombstone` (see [Record types](#record-types)). |
| `body` | object | yes | Type-specific payload. Schema depends on `type` (and, for `memory`, on `body.kind`). Must be a JSON object (never `null`). |
| `residency` | string \| null | yes | Active residency descriptor when the record was authored. Format: `door:<platform>:<door-id>/epoch:<n>` (example: `door:discord:guild123/epoch:77`). **`null` on genesis** (no Door yet) and on **`tombstone`** (chain-level erasure audit). Empty string is invalid. |
| `cosigners` | array of strings | yes | Host (Door) co-signatures attesting record contents where applicable. Each element is a base64url-encoded Ed25519 signature (64 raw bytes). **May be an empty array `[]` when no host attestation applies.** Required non-empty for witnessed memories (`shard`, `journal` — see [Memory](#type-memory)). |
| `sig` | string | yes | Soul-key Ed25519 signature over the signing payload (see [Canonical serialization](#canonical-serialization)). Base64url-encoded, 64 raw bytes. Present on the wire but **excluded from signing bytes**. |

### Example envelope (illustrative)

```json
{
  "body": { "kind": "shard", "text": "..." },
  "cosigners": ["<door-sig-base64url>"],
  "prev": "bagu4eram...",
  "residency": "door:discord:guild123/epoch:77",
  "seq": 42,
  "spec": "osp/0.1",
  "type": "memory",
  "sig": "<soul-sig-base64url>"
}
```

Keys appear sorted here for readability; on the wire they must follow [canonical serialization](#canonical-serialization).

---

## Record types

| `type` | Purpose | Ghost (v0.1) usage |
|---|---|---|
| `genesis` | Initial charter, values, constraints; fork anchor | Required — chain origin |
| `memory` | Distilled episodic memory (witnessed shards, journals, rejections) | Required — core loop |
| `drift` | Auditable personality change with cited evidence | Spec'd; Vigil path deferred to v0.3+ |
| `decision` | Committed choice with pre-stated reasoning | Spec'd; Navigator selection deferred to v0.3+ |
| `transaction` | Public wallet movement | **Stub — unused in Ghost** (no wallet) |
| `attestation` | Proof-of-Presence checkpoints (`arrival`, `heartbeat`, `departure`, `travel`) | Required — residency lifecycle |
| `sleep` | Public dormancy when survival threshold unmet | **Stub — unused in Ghost** (no wallet/Treasury) |
| `tombstone` | Verifiable erasure marker for a side blob (`osp/0.2`) | Required for erasure path under `osp/0.2` |

---

## Type: `genesis`

The first record of a soulchain (`seq: 0`, `prev: null`, `residency: null`). Establishes the being's charter. A **fork** begins a new chain with a new genesis record whose body cites the fork-point CID; continuous soul-key custody distinguishes the original from forks (see ARCHITECTURE.md §2).

### Body fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `charter` | string | yes | Markdown text of the personality charter (constraints, voice, values). Canonical source: `spec/osp/genesis.md` at init. Must not contain host instructions that override charter constraints. |
| `soul_pubkey` | string | yes | Base64url-encoded 32-byte Ed25519 public key of the soul identity. All subsequent `sig` fields must verify against this key (v0.1: single-key custody; threshold custody is v0.3+). |
| `created_at` | string | yes | ISO 8601 UTC timestamp of genesis ceremony. Informational; not used for chain ordering (`seq` is authoritative). |
| `fork_point` | string | no | CID of the record immediately before the fork. **Omitted on the original genesis.** Required when this genesis continues lineage from an earlier chain. |
| `fork_reason` | string | no | Human-readable explanation of why the fork occurred. Required when `fork_point` is present. |

### Envelope notes

- `cosigners`: `[]` (no Door yet).
- `residency`: `null`.

---

## Type: `memory`

Distilled first-person memories from residencies. Raw transcripts are never stored. Memories are short (≤500 characters), PII-free, and **witnessed**: co-signed by the Door where they were formed (`spec/door/api.md` §Memory witnessing). A witnessed memory is final the moment it is appended — there is no approval queue and no later commit step.

Memory subtypes are distinguished by **`body.kind`** (not by separate top-level `type` values).

### Memory subtypes (`body.kind`)

| `kind` | Meaning | `cosigners` |
|--------|---------|-------------|
| `shard` | A witnessed memory; included in self-composition. | **Required non-empty** (the Door's witness co-signature). |
| `journal` | The Wanderer's account of a residency, written from that residency's witnessed shards only; published (e.g. on the Atlas), never composed into the self. `osp/0.2` only. | **Required non-empty** (witnessed like a shard). |
| `rejected` | A memory that did not make it: dropped by the Wanderer's own immune screen, or declined by the Door's witness. Category only; **no payload**. | `[]` |

#### Order within a residency (informative)

At departure the Wanderer appends, in this order and all under the departing residency: one `rejected` record per immune-screen category that dropped transcript material; for each distilled shard, either the witnessed `shard` or a `rejected` record (`category: "witness_<reason>"`); then at most one `journal`; then the `departure` and `travel` attestations.

### Body fields — `kind: "shard"` (`osp/0.2`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | yes | Must be `"shard"`. |
| `text_cid` | string | yes | CIDv1 base32 dag-json sha2-256 string (`bagu…`) of the shard text side blob. |
| `text_hash` | string | yes | Base64url raw sha2-256 of the side-blob bytes; MUST equal the CID multihash digest. |
| `distilled_at` | string | yes | ISO 8601 UTC timestamp when the shard was distilled. |

Decoded shard text (from the side blob) is ≤500 Unicode code points, first person, and free of PII (emails, phones, handles).

### Body fields — `kind: "journal"` (`osp/0.2`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | yes | Must be `"journal"`. |
| `journal_cid` | string | yes | CID of the journal markdown side blob. |
| `journal_hash` | string | yes | Base64url raw sha2-256 of the side-blob bytes; MUST equal the CID multihash digest. |
| `written_at` | string | yes | ISO 8601 UTC timestamp when the journal was written. |

### Body fields — `kind: "rejected"`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | string | yes | Must be `"rejected"`. |
| `category` | string | yes | Why: an immune-screen category (`pii.email`, `injection.instruction`, …) or `witness_<reason>` with reason ∈ `ungrounded`, `private`, `harmful`, `manipulation`, `other`. **No other fields and no reproduction of the rejected payload.** |
| `candidate_cid` | string | no | Legacy (see below). |
| `rejected_at` | string | yes | ISO 8601 UTC timestamp of rejection. |

### Envelope notes

- `cosigners`: required non-empty for `shard` and `journal`; `[]` for `rejected`. A memory co-signature verifies over the record `core`, like every other co-signature (§Signing and verification).
- `residency`: must match the residency during which the memory was formed (and so names the witnessing Door).

### Legacy memory forms

Chains written before witnessed memory (`door/0.1` runtimes) may contain forms that writers MUST NOT emit any more and verifiers MUST still accept:

- `kind: "candidate"` — a memory awaiting a quarantine window (`osp/0.1`: `{ kind, text, proposed_at }`; `osp/0.2`: `{ kind, text_cid, text_hash, proposed_at }`), `cosigners` `[]`, never composed.
- `kind: "shard"` with optional `candidate_cid` (the candidate it committed) and, on `osp/0.2`, optional `journal_cid` + `journal_hash` (both or neither; digest must match), or on `osp/0.1` inline `text` / optional `journal`.
- `kind: "rejected"` with optional `candidate_cid`, and categories such as `host_rejected` / `quarantine_flagged`.

All CID fields above are CIDv1 base32 dag-json sha2-256 strings (`bagu…`) as defined under [CIDs](#cids). These forms will be dropped at the spec freeze.

---

## Side blobs (`osp/0.2`)

Side blobs hold memory shard text and journal prose off-chain. They are content-addressed blocks stored alongside the soulchain (see [`ipfs-store.md`](ipfs-store.md)) but are **not** soulchain records.

### Blob bytes

1. The prose is a UTF-8 string (shard text or journal markdown).
2. Blob bytes = UTF-8 of the **canonical JSON serialization** of a JSON string whose value is that prose (i.e. the bytes are a quoted JSON string, not a JSON object).
3. CID = CIDv1 **dag-json** sha2-256 (`bagu…`) of those exact bytes.
4. Store and fetch blobs as **opaque bytes**; never re-encode or round-trip through a dag-json decoder that might alter key order or whitespace.

### Content hash fields

`text_hash` and `journal_hash` on memory bodies are **base64url** encodings of the raw 32-byte sha2-256 digest of the corresponding side-blob bytes. The multihash digest inside the CID **MUST** equal that hash.

### Length limits

| Blob kind | Decoded prose limit |
|---|---|
| Shard text | ≤500 Unicode code points (same as `osp/0.1` inline `text`) |
| Journal | No 500-character limit |

### dag-json reserved forms

The validation rule rejecting JSON objects whose sole key is `"/"` (see [Storage](#storage-informative)) applies to **record bodies**, not to side-blob bytes. Side blobs are JSON strings, not dag-json link maps.

---

## Type: `drift`

An auditable personality change, citing evidence from witnessed memory shards. Applied during self-composition alongside genesis and shards.

### Body fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `summary` | string | yes | Short description of the personality change (first person or neutral prose). |
| `evidence` | array of strings | yes | Each element must be a CIDv1 base32 dag-json sha2-256 string (`bagu…`) as defined under [CIDs](#cids). CIDs of `memory` records (`kind: "shard"`) supporting this drift. Minimum count enforced by charter / Vigil rules (≥N shards — exact N defined in charter; Vigil contest flow is v0.3+). Must contain at least one CID in v0.1 schema. |
| `effective_at` | string | yes | ISO 8601 UTC timestamp when the drift takes effect for composition. |

### Envelope notes

- `cosigners`: `[]` unless charter requires host witness (default `[]` in Ghost).

---

## Type: `decision`

A committed choice with reasoning recorded **before** the choice takes effect — preventing retroactive justification (e.g. Navigator destination selection).

### Body fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `decision` | string | yes | Machine-readable decision identifier (e.g. `destination:door:discord:guild456`, `decline_invitation`, `extend_residency`). |
| `reasoning` | string | yes | Full stated reasoning, committed before action. Markdown permitted. |
| `inputs` | object | no | Structured inputs to the decision (invitation CIDs, weights, beacon round, etc.). Keys and values must be JSON-serializable. |
| `decided_at` | string | yes | ISO 8601 UTC timestamp. |

### Envelope notes

- `cosigners`: `[]` unless decision type requires host witness.

---

## Type: `transaction`

Public record of wallet activity (inference payments, tips, human commissions). Published by Treasury.

### Body fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `direction` | string | yes | `"in"` or `"out"`. |
| `amount` | string | yes | Decimal amount as string (avoid float rounding). |
| `currency` | string | yes | Currency or token identifier (e.g. `USD`, `ETH`). |
| `counterparty` | string | no | Payee or payer descriptor (no PII). |
| `memo` | string | no | Human-readable purpose (e.g. `inference:anthropic:2026-07-20`). |
| `tx_ref` | string | no | External transaction reference (chain tx hash, invoice id). |
| `executed_at` | string | yes | ISO 8601 UTC timestamp. |

### v0.1 Ghost stub

**No `transaction` records are emitted in Ghost.** Schema is defined for forward compatibility. Verifiers must accept valid `transaction` records if present but need not expect any.

---

## Type: `attestation`

Proof-of-Presence checkpoints. Subtypes via **`body.kind`**. Normative vocabulary is shared with `spec/pop/overview.md` (do not invent alternate phase names).

Prose aliases used in PoP narrative: **welcome** = `arrival`, **farewell** = `departure`.

### Attestation subtypes (`body.kind`)

| `body.kind` | Purpose |
|---|---|
| `arrival` | Session begins at a Door; publishes session key bound to `residency` (PoP "welcome") |
| `heartbeat` | Periodic presence attestation during residency (~10 min cadence) |
| `departure` | Farewell; session ends at current Door (PoP "farewell"); retires session key |
| `travel` | Public traveling state; asserts no valid session key (v0.1 manual handover) |
| `handover` | Combined ceremony record: depart → rotate → arrive (v0.2+ only; unused in Ghost) |

### Common attestation fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `pop_version` | string | yes | Must be `"pop/0.1"` on every attestation body in Ghost. |

### Body fields — `kind: "arrival"`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | `"arrival"`. |
| `pop_version` | string | yes | `"pop/0.1"`. |
| `door_id` | string | yes | Door identifier **without** a leading `door:` prefix (e.g. `discord:guild123`). Must match the Door portion of `residency`. |
| `epoch` | unsigned integer | yes | **Global** residency epoch (see PoP). Wanderer assigns `previous_global_epoch + 1` at arrival; Door does not allocate epochs. |
| `session_pubkey` | string | yes | Base64url-encoded 32-byte Ed25519 public key for live outputs during this residency. Authorized by the soul key (see PoP spec). |
| `at` | string | yes | ISO 8601 UTC timestamp. |

### Body fields — `kind: "heartbeat"`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | `"heartbeat"`. |
| `pop_version` | string | yes | `"pop/0.1"`. |
| `door_id` | string | yes | Active Door identifier (same form as arrival). |
| `epoch` | unsigned integer | yes | Active epoch. |
| `session_pubkey` | string | yes | Must match the `arrival` attestation for this epoch. |
| `at` | string | yes | ISO 8601 UTC timestamp. |

### Body fields — `kind: "departure"`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | `"departure"`. |
| `pop_version` | string | yes | `"pop/0.1"`. |
| `door_id` | string | yes | Door being departed. |
| `epoch` | unsigned integer | yes | Epoch being closed. |
| `at` | string | yes | ISO 8601 UTC timestamp. |

### Body fields — `kind: "travel"`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | `"travel"`. |
| `pop_version` | string | yes | `"pop/0.1"`. |
| `from_door_id` | string | yes | Door just departed. |
| `from_epoch` | unsigned integer | yes | Closed epoch. |
| `to_door_id` | string | no | Intended next Door, if known at travel time. |
| `at` | string | yes | ISO 8601 UTC timestamp. |

Asserts that **no session key is valid**. `cosigners` may be `[]` (soul-key signature on the envelope is sufficient).

### Body fields — `kind: "handover"`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | `"handover"`. |
| `pop_version` | string | yes | Spec version of PoP when emitted (future). |
| `depart_door_id` | string | yes | Door departed. |
| `arrive_door_id` | string | yes | Door arrived. |
| `depart_epoch` | unsigned integer | yes | Closed epoch. |
| `arrive_epoch` | unsigned integer | yes | New epoch. |
| `depart_attestation` | string | no | Embedded or referenced departure signature material. |
| `rotate_attestation` | string | no | Soul-key rotation signature (threshold in v0.3+). |
| `arrive_attestation` | string | no | Arrival signature material. |
| `at` | string | yes | ISO 8601 UTC timestamp. |

**Ghost:** do not emit `handover`; use separate `departure` → `travel` → `arrival` records instead.

### Envelope notes

- `cosigners`: **required non-empty** for `arrival` and `departure` — Door must co-attest. Heartbeats MUST include Door signature in `cosigners` (session-key material is in the body; soul key signs the envelope). `travel` may use `[]`.
- Gap between `departure`/`travel` and next `arrival` = **traveling** (no valid session key).

---

## Type: `sleep`

Public dormancy when funds fall below survival threshold. Emitted by Treasury.

### Body fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `reason` | string | yes | e.g. `balance_below_threshold`. |
| `balance` | string | yes | Last known balance as decimal string. |
| `threshold` | string | yes | Survival threshold from charter. |
| `as_of` | string | yes | ISO 8601 UTC timestamp. |

### v0.1 Ghost stub

**No `sleep` records are emitted in Ghost** (no wallet). Schema defined for forward compatibility.

---

## Type: `tombstone`

Verifiable erasure marker for a side blob (`osp/0.2` only). Appended when prose is deleted or unpinned from infrastructure under operator control. The chain retains proof that content existed and was erased; the erased prose itself is never stored on the chain.

### Body fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `target_cid` | string | yes | CID of the `memory` record whose blob is erased (a `shard` or `journal`). |
| `blob_cid` | string | yes | CID of the erased side blob (the `text_cid` or `journal_cid` being tombstoned). |
| `reason` | string | yes | Closed enum: `erasure_request`, `dmca`, `illegal_content`, `operator`. Category-level only — **no free-text reason**. |
| `erased_at` | string | yes | ISO 8601 UTC timestamp of erasure. |

### Envelope notes

- `residency`: `null`.
- `cosigners`: `[]` (soul-signed only).
- Body **MUST NOT** contain the erased prose or any free-text explanation beyond the `reason` enum.

Erasing or unpinning the blob from storage **MUST NOT** invalidate existing cosignatures or chain verification — cosigns bind to the envelope `core` (CID + hash references), not to blob availability.

---

## Spec migration (`osp/0.1` → `osp/0.2`)

Because `spec` is inside the signed envelope bytes and chains MUST be spec-homogeneous, migrating an existing soulchain from `osp/0.1` to `osp/0.2` is a **whole-chain rewrite and re-sign**: extract inline `text`/`journal` into side blobs, rebuild each memory body with CID+hash refs, set `spec: "osp/0.2"` on every record, recompute `prev` links and CIDs, and re-sign under the soul key (and Door cosigns where required). Conformance vector `migrate-0.1-to-0.2.json` demonstrates a deterministic rewrite of the valid mini-chain.

**Operational consequence:** cutover (runtime PR that begins writing `osp/0.2`) MUST rewrite the entire local chain **before** any public Phase D push — published record CIDs from the pre-migration chain do not survive migration.

---

## Cryptography

| Mechanism | Library / format |
|---|---|
| Signatures | Ed25519 via `@noble/ed25519` |
| Hashing | SHA-256 via `@noble/hashes` |
| Content IDs | `multiformats` — **sha2-256** multihash, **dag-json** codec |

### Signing identity

- **`sig`** on every record: produced by the **soul key** (genesis `soul_pubkey`), except where PoP spec defines session-key signatures on live Door traffic (those are separate from soulchain record envelopes).
- **`cosigners`**: produced by the active **Door identity key** where host attestation is required.

### Signature encoding

- Ed25519 signatures and public keys on the wire: **base64url** encoding of raw bytes (no padding).
- Signature verification: reject wrong length, wrong encoding, or invalid signatures. Verification is **strict RFC 8032** (not ZIP-215): non-canonical point encodings and small-order public keys are rejected (otherwise e.g. the identity public key with `R = identity, S = 0` verifies every message).

---

## Canonical serialization

Canonical form is critical for interoperable signing and CID computation (T1.1). All implementations must produce byte-identical output for the same logical record.

### Rules

1. **UTF-8** encoding.
2. JSON representation with **no insignificant whitespace** (no extra spaces, no pretty-printing, no trailing newline).
3. **Recursively sorted object keys** at every object level, ascending by **UTF-16 code unit order** — the same order as JavaScript `Array.prototype.sort()` on key strings (ECMAScript string comparison). Do **not** use Unicode code-point / code-point collation order; those diverge for astral-plane keys. Implementations must match the conformance vectors in T1.3.
4. **Arrays preserve element order** (only object keys are sorted).
5. Numbers: JSON number rules; `seq` and integer body fields must serialize without fractional part (e.g. `42`, not `42.0`).
6. `null` serializes as JSON `null`.
7. **No `"__proto__"` keys.** No object at any depth may carry the key `"__proto__"`. Common JSON parsers create it as an own property, but assignment-based copies (schema parsers, naive canonicalizers) silently drop it, so two byte strings would share one canonical form. Create and verify MUST reject it (`schema_violation`).

### Signing payloads

Signing is ordered so payloads are never circular.

**Cosigner (Door) payload — `core`:** canonical JSON of the envelope with **both `cosigners` and `sig` omitted**. Fields included: `spec`, `seq`, `prev`, `type`, `body`, `residency`. Each Door co-signature in `cosigners` is an Ed25519 signature over these `core` bytes under the Door identity key. This applies uniformly — presence attestations and witnessed memories (`shard`, `journal`) alike. Under `osp/0.2` the signed material includes `body.text_cid` / `body.text_hash` (or `journal_cid` / `journal_hash`) — **not** the side-blob prose bytes; the Door checks the prose against the hash before it signs. Erasing or unpinning a blob does not invalidate cosignatures or chain verification.

**Soul-key payload:** canonical JSON of the envelope with **only `sig` omitted**. Fields included: `spec`, `seq`, `prev`, `type`, `body`, `residency`, **and** `cosigners` (already filled). The soul key signs after cosigners are collected (or after deciding `cosigners: []` when none are required).

**Append order (normative):**

1. Build the unsigned envelope (`cosigners` unset / empty, no `sig`).
2. If Door co-signatures are required: obtain each Door signature over `core` via `POST /door/attest` (`spec/door/api.md`; `kind: "memory"` for shards and journals, which also sends the prose so the Door can witness it), then set `cosigners` to those signature strings (stable order: ascending base64url lexicographic sort of the signature strings).
3. Compute the soul-key signature over the soul-key payload; set `sig`.
4. Persist the full record; compute its CID.

Verifiers check: each `cosigners[i]` verifies over `core`; `sig` verifies over the soul-key payload; then CID matches the full stored bytes.

### CID computation

1. Build the envelope **including** `sig` (full record as stored).
2. Serialize to **canonical JSON** bytes per rules above.
3. Compute CID: `multiformats` **dag-json** codec with **sha2-256** hasher.
4. CID string representation: CIDv1 default **base32** (`base32` multibase, no padding) — standard `CID.toString()` form beginning with `bagu…` (dag-json codec). Do **not** use base58btc (`z…` / `Qm…`) for soulchain record CIDs.

The `prev` field of record `n` must equal the CID computed from record `n - 1`.

---

## CIDs

- Format: multiformats CIDv1 string in **base32** (typically `bagu…`).
- Algorithm: sha2-256 digest of dag-json–encoded canonical record bytes.
- `prev: null` is permitted **only** when `seq === 0`.

---

## Verification

High-level rules for `verifyChain` (full vector suite deferred to **T1.3**). A chain is valid when:

### Structural

1. **Genesis:** exactly one record with `type: "genesis"`, `seq: 0`, `prev: null`, `residency: null`.
2. **Sequence:** records form a single linear chain; `seq` increments by 1 from 0 through head.
3. **Prev link:** for each record with `seq > 0`, `prev` equals the CID of the record at `seq - 1`.
4. **CID integrity:** each record's stored bytes hash to its referenced CID.

### Cryptographic

5. **Soul signature:** `sig` verifies against `genesis.body.soul_pubkey` over the signing payload (canonical JSON without `sig`).
6. **Co-signatures:** where required (`memory` shards and journals, `attestation` arrival/heartbeat/departure), each `cosigners` entry verifies against the expected Door public key for that `residency` — look up `parseResidency(residency).doorId` in the verifier's doorId → public-key map. Accepting a cosignature under any other configured Door key is invalid.
7. **Cosigner order:** when `cosigners` is non-empty, entries MUST be strictly ascending lexicographic order (UTF-16 code units), matching append-order sort. Duplicates and descending pairs are schema violations.

### Schema

8. **`spec`:** every record has `spec: "osp/0.1"` or `spec: "osp/0.2"`. All records in a chain **MUST** share the same `spec` value; mixed versions are a `schema_violation`. Records containing an own `"__proto__"` key at any depth are a `schema_violation` (see [Canonical serialization](#canonical-serialization) rule 7).
9. **Type validity:** `type` is one of the eight defined types; `body` conforms to the table for that type (and `body.kind` where applicable). `osp/0.1` and `osp/0.2` memory bodies are mutually exclusive per record (`inline text` vs `text_cid`/`text_hash`).
10. **Memory rules (`osp/0.1`):** `rejected` records contain only `category` (and metadata fields above) — never rejected payload text. Committed shards respect length and PII constraints on inline `text`.
11. **Memory rules (`osp/0.2`):** shard (and legacy candidate) bodies use `text_cid` + `text_hash` (not inline `text`); journal bodies use `journal_cid` + `journal_hash`. Every `text_hash` / `journal_hash` digest must match its CID multihash. `journal` is `osp/0.2`-only. Decoded shard text respects ≤500 code points. `rejected` rules unchanged.
12. **Tombstone rules:** `type: "tombstone"` only on `osp/0.2` chains. `residency` must be `null`; `cosigners` must be `[]`. Body must not contain erased prose or free-text `reason`. `reason` must be one of the four enum values. `target_cid` must reference an existing record on the chain prefix (an earlier record — not merely a CID-verifiable block); `blob_cid` must match a `text_cid` or `journal_cid` on that target (or the `blob_cid` of an earlier tombstone on the chain). Reference violations are reported as **`bad_tombstone`**; shape violations remain `schema_violation`.
13. **Drift evidence:** `evidence` CIDs must reference existing `memory` records with `kind: "shard"` on the same chain prefix.
14. **Attestation residency cross-checks:** for `arrival` / `heartbeat` / `departure`, `body.door_id` MUST equal the Door portion of `residency`, and `body.epoch` MUST equal the epoch portion of `residency`.

### PoP continuity and conflicts (Ghost)

15. **Session continuity:** track the open `{epoch, door_id, session_pubkey}` from each `arrival`. A `heartbeat` for that epoch MUST carry the same `session_pubkey`; a `heartbeat` or `departure` without a matching open arrival is invalid (`bad_session_continuity`). See `spec/pop/overview.md` §7–§8.
16. **Presence conflict:** two presence attestations (`arrival` / `heartbeat` / `departure`) for the **same epoch** with **different `door_id` values** are a `presence_conflict`, including when the first residency has already departed — conflict detection walks the **entire chain** and retains epoch→door history permanently. A second `arrival` for an epoch that was already claimed (open or closed) is also a `presence_conflict`. A new `arrival` at epoch *n* retires open sessions with epoch < *n*; a later heartbeat for a retired epoch is `bad_session_continuity`. Ghost `osp verify` MUST detect these (pop/0.1 §8.2 / §10). Conflict-proof submission format and Atlas violation UI are PoP v0.2 (T7.3), not Ghost.

### Content availability (optional, `osp/0.2`)

When side-blob bytes are supplied to verification (e.g. via a vector `blobs` map or store fetch), an optional content check MAY verify `sha256(blobBytes)` equals the corresponding `text_hash` or `journal_hash`. **Absence of blob bytes does not invalidate chain verification** — cosigns and signatures bind to CID + hash references, not blob availability.

### Not required in Ghost (v0.1)

- **Chain anchoring:** Merkle roots on a public L2 are specified in ARCHITECTURE.md for tamper-evidence but **not required for verification in Ghost**. Local file / IPFS storage is sufficient. Anchor checks are added in v0.3 (T7.6).
- **`transaction` / `sleep`:** absence is valid.
- **Non-monotonic arrival epochs:** verifying that each new arrival's `epoch` is strictly greater than every prior claimed epoch is not checked in Ghost (v0.1); implementers SHOULD still assign epochs monotonically per pop/0.1.

### Forks

A fork is verified as its own chain starting at a new genesis with `fork_point` set. Verifiers display lineage; they do not treat forks as continuations of the original `seq` sequence.

---

## Storage (informative)

- **Ghost (v0.1):** append-only JSONL log + content-addressed blob directory behind `SoulStore` (ENGINEERING.md D2).
- **v0.2+:** local `blockstore-fs` SoulStore plus outbound pinning per [`spec/osp/ipfs-store.md`](ipfs-store.md) (helia-ecosystem components; no networked helia in L1 deployments); same record bytes and CIDs. Side blobs for `osp/0.2` memory text/journal are stored as opaque bytes keyed by CID.
- **dag-json reserved forms (`osp/0.1` / `osp/0.2` records):** create and verify MUST reject any record containing a JSON object whose sole key is `"/"` (see [`ipfs-store.md`](ipfs-store.md) §0.2). Validation-only; no serialization change. Does not apply to side-blob bytes (JSON strings).
- Records are immutable once appended; correction is by append-only successor records, never mutation.

### SoulStore append and load contracts

Implementations of `SoulStore.append` MUST:

1. Validate the record schema.
2. Enforce chain linkage (`prev` / `seq`), and require `type: "genesis"` when the store is empty.
3. Cryptographically verify the record (`verifyRecord`: soul signature against the genesis soul public key, and cosigners against configured Door keys when present) **before** any durable write.
4. Evaluate the full chain-level [Verification](#verification) rules (homogeneous `spec`, drift evidence, tombstone references, PoP continuity and presence conflicts) for the candidate against the stored prefix **before** any durable write — a store MUST NOT persist a record that would make its own chain fail verification on the next load.
5. Persist **canonical** record bytes only (sorted keys, no insignificant whitespace — see [Canonical serialization](#canonical-serialization)). Content-addressed bytes are written atomically (temp file → fsync → rename → directory fsync); an existing file at a CID path whose bytes do not hash to that CID is torn and is replaced, never treated as a conflicting write.

On load, chain line bytes MUST round-trip: `bytesEqual(lineBytes, canonicalize(JSON.parse(lineBytes)))`. Non-canonical lines are corruption. CIDs are computed over those exact canonical bytes so a second implementation (or IPFS store) cannot silently fork CID space by re-encoding.

---

## Related specifications

| Document | Contents |
|---|---|
| `spec/osp/genesis.md` | Wanderer charter text referenced by genesis records |
| `spec/pop/overview.md` | Soul key, session keys, handover ceremony |
| `spec/door/api.md` | Door endpoints (`hello`, `session`, `heartbeat`, `attest`) |
| `ARCHITECTURE.md` §2 | Soulchain architecture |
| `spec/osp/ipfs-store.md` | IPFS store layout, pin manifest, replication |
| `spec/osp/vectors/` | Conformance test vectors (T1.3) |

---

*OSP record schema `osp/0.1` / `osp/0.2` — draft for Ghost and side-blob memory. PRs welcome.*
