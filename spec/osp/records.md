# Open Soul Protocol — Soulchain Records

| | |
|---|---|
| **Version** | `osp/0.1` |
| **License** | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| **Status** | Draft — v0.1 "Ghost" |

This document is the authoritative prose schema for OSP soulchain records at version `osp/0.1`. When this spec and implementation disagree, **this spec wins**. Conformance test vectors are defined separately (see [Verification](#verification); vectors deferred to T1.3).

---

## Overview

The soulchain is an append-only, hash-linked log of signed records. Each record is content-addressed (CID) and cryptographically chained to its predecessor. Together the chain constitutes the Wanderer's identity: genesis charter, memories, drift, decisions, attestations, and (in later milestones) transactions.

A conforming runtime loads the chain head, verifies integrity, and composes the current self from genesis + drift + committed memory shards. Raw conversation transcripts are never stored on the chain.

---

## Record envelope

Every soulchain record is a JSON object with the following top-level fields. The envelope is signed as a unit (see [Canonical serialization](#canonical-serialization)).

| Field | Type | Required | Constraints |
|---|---|---|---|
| `spec` | string | yes | Must be exactly `"osp/0.1"` on every record. Identifies the schema version independently of package semver (see ENGINEERING.md D6). |
| `seq` | unsigned integer | yes | Monotonic sequence number. **Genesis uses `seq: 0`.** Each subsequent record increments by exactly 1 (`1`, `2`, `3`, …). No gaps, no reuse. |
| `prev` | string \| null | yes | When present, must be a CIDv1 base32 dag-json sha2-256 string (`bagu…`) as defined under [CIDs](#cids). CID of the previous record. **`null` only on the genesis record** (`seq: 0`). All other records must contain a valid CID string equal to the CID of record `seq - 1`. |
| `type` | string | yes | One of: `genesis`, `memory`, `drift`, `decision`, `transaction`, `attestation`, `sleep` (see [Record types](#record-types)). |
| `body` | object | yes | Type-specific payload. Schema depends on `type` (and, for `memory`, on `body.kind`). Must be a JSON object (never `null`). |
| `residency` | string \| null | yes | Active residency descriptor when the record was authored. Format: `door:<platform>:<door-id>/epoch:<n>` (example: `door:discord:guild123/epoch:77`). **`null` only on genesis** — the being has no Door before first arrival. Empty string is invalid. |
| `cosigners` | array of strings | yes | Host (Door) co-signatures attesting record contents where applicable. Each element is a base64url-encoded Ed25519 signature (64 raw bytes). **May be an empty array `[]` when no host attestation applies.** Required non-empty for committed memory shards (see [Memory](#type-memory)). |
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
| `memory` | Distilled episodic memory (shards, quarantine lifecycle) | Required — core loop |
| `drift` | Auditable personality change with cited evidence | Spec'd; Vigil path deferred to v0.3+ |
| `decision` | Committed choice with pre-stated reasoning | Spec'd; Navigator selection deferred to v0.3+ |
| `transaction` | Public wallet movement | **Stub — unused in Ghost** (no wallet) |
| `attestation` | Proof-of-Presence checkpoints (`arrival`, `heartbeat`, `departure`, `travel`) | Required — residency lifecycle |
| `sleep` | Public dormancy when survival threshold unmet | **Stub — unused in Ghost** (no wallet/Treasury) |

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

Distilled first-person memories from residencies. Raw transcripts are never stored. Shards are short (≤500 characters), PII-free, and host-co-signed when committed.

Memory subtypes are distinguished by **`body.kind`** (not by separate top-level `type` values).

### Memory subtypes (`body.kind`)

| `body.kind` | Meaning | Ghost usage |
|---|---|---|
| `shard` | **Committed** memory — passed quarantine and host co-signing; included in self-composition | Primary durable memory |
| `candidate` | **Candidate** shard — published for quarantine; not yet composed into self | Quarantine entry (T3.2) |
| `rejected` | **Rejected** candidate — immune screen or operator rejection | Category only; **no payload** (T3.2) |

#### Transition rules (informative)

1. Distiller emits `memory` with `kind: "candidate"`.
2. After quarantine window with no successful challenge, a new `memory` with `kind: "shard"` is appended (may reference the candidate CID). Candidate remains on chain for audit.
3. On rejection, append `memory` with `kind: "rejected"` — **must not** reproduce the candidate text.

### Body fields — `kind: "shard"` (committed)

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | Must be `"shard"`. |
| `text` | string | yes | First-person memory text. **Max 500 Unicode code points.** No PII (emails, phones, handles). No raw quotes of others without explicit host consent recorded in cosigning. |
| `candidate_cid` | string | no | When present, must be a CIDv1 base32 dag-json sha2-256 string (`bagu…`) as defined under [CIDs](#cids). CID of the `candidate` record this shard commits, if any. |
| `journal` | string | no | Markdown residency journal (Wanderer's account of the stay). May be lengthy; not subject to the 500-character shard limit. |
| `distilled_at` | string | yes | ISO 8601 UTC timestamp of distillation. |

### Body fields — `kind: "candidate"`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | Must be `"candidate"`. |
| `text` | string | yes | Proposed first-person memory. Same length and PII constraints as committed shards (max 500 code points). |
| `proposed_at` | string | yes | ISO 8601 UTC timestamp when the candidate entered quarantine. |

### Body fields — `kind: "rejected"`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `kind` | string | yes | Must be `"rejected"`. |
| `category` | string | yes | Rejection reason category (e.g. `injection`, `pii`, `charter_violation`, `host_rejected`, `quarantine_flagged`). **No other fields and no reproduction of the rejected payload.** |
| `candidate_cid` | string | no | When present, must be a CIDv1 base32 dag-json sha2-256 string (`bagu…`) as defined under [CIDs](#cids). CID of the rejected candidate record, if the rejection refers to a specific candidate. |
| `rejected_at` | string | yes | ISO 8601 UTC timestamp of rejection. |

### Envelope notes

- `cosigners`: **required non-empty** for `kind: "shard"` — at least one valid Door signature attesting fair account of the residency. May be `[]` for `candidate` and `rejected`.
- `residency`: must match the residency during which the memory was formed.

---

## Type: `drift`

An auditable personality change, citing evidence from committed memory shards. Applied during self-composition alongside genesis and shards.

### Body fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `summary` | string | yes | Short description of the personality change (first person or neutral prose). |
| `evidence` | array of strings | yes | Each element must be a CIDv1 base32 dag-json sha2-256 string (`bagu…`) as defined under [CIDs](#cids). CIDs of **committed** `memory` records (`kind: "shard"`) supporting this drift. Minimum count enforced by charter / Vigil rules (≥N shards — exact N defined in charter; Vigil contest flow is v0.3+). Must contain at least one CID in v0.1 schema. |
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
- Signature verification: reject wrong length, wrong encoding, or invalid signatures.

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

### Signing payloads

Signing is ordered so payloads are never circular.

**Cosigner (Door) payload — `core`:** canonical JSON of the envelope with **both `cosigners` and `sig` omitted**. Fields included: `spec`, `seq`, `prev`, `type`, `body`, `residency`. Each Door co-signature in `cosigners` is an Ed25519 signature over these `core` bytes under the Door identity key.

**Soul-key payload:** canonical JSON of the envelope with **only `sig` omitted**. Fields included: `spec`, `seq`, `prev`, `type`, `body`, `residency`, **and** `cosigners` (already filled). The soul key signs after cosigners are collected (or after deciding `cosigners: []` when none are required).

**Append order (normative):**

1. Build the unsigned envelope (`cosigners` unset / empty, no `sig`).
2. If Door co-signatures are required: obtain each Door signature over `core` via the Door API (`POST /door/attest` for attestation kinds; `POST /door/cosign` for memory shards — see `spec/door/api.md`), then set `cosigners` to those signature strings (stable order: ascending base64url lexicographic sort of the signature strings).
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
6. **Co-signatures:** where required (committed `memory` shards, `attestation` arrival/heartbeat/departure), each `cosigners` entry verifies against the expected Door public key for that `residency`.

### Schema

7. **`spec`:** every record has `spec: "osp/0.1"`.
8. **Type validity:** `type` is one of the seven defined types; `body` conforms to the table for that type (and `body.kind` where applicable).
9. **Memory rules:** `rejected` records contain only `category` (and metadata fields above) — never rejected payload text. Committed shards respect length and PII constraints.
10. **Drift evidence:** `evidence` CIDs must reference existing `memory` records with `kind: "shard"` on the same chain prefix.

### Not required in Ghost (v0.1)

- **Chain anchoring:** Merkle roots on a public L2 are specified in ARCHITECTURE.md for tamper-evidence but **not required for verification in Ghost**. Local file / IPFS storage is sufficient. Anchor checks are added in v0.3 (T7.6).
- **`transaction` / `sleep`:** absence is valid.

### Forks

A fork is verified as its own chain starting at a new genesis with `fork_point` set. Verifiers display lineage; they do not treat forks as continuations of the original `seq` sequence.

---

## Storage (informative)

- **Ghost (v0.1):** append-only JSONL log + content-addressed blob directory behind `SoulStore` (ENGINEERING.md D2).
- **v0.2+:** IPFS pinning via `helia`; same record bytes and CIDs.
- Records are immutable once appended; correction is by append-only successor records, never mutation.

---

## Related specifications

| Document | Contents |
|---|---|
| `spec/osp/genesis.md` | Wanderer charter text referenced by genesis records |
| `spec/pop/overview.md` | Soul key, session keys, handover ceremony |
| `spec/door/api.md` | Door endpoints (`hello`, `session`, `heartbeat`, `attest`, `cosign`) |
| `ARCHITECTURE.md` §2 | Soulchain architecture |
| `spec/osp/vectors/` | Conformance test vectors (T1.3) |

---

*OSP record schema `osp/0.1` — draft for Ghost. PRs welcome.*
