# Proof-of-Presence (PoP)

**Spec version:** `pop/0.1`  
**License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)  
**Scope:** v0.1 "Ghost" only — single-key custody, manual handover, no on-chain anchors.

---

## 1. Purpose

Proof-of-Presence (PoP) is the protocol layer that makes the Wanderer's **scarcity of presence** verifiable: at most one active residency per epoch, outputs bound to a specific Door, and a publicly visible **traveling** state when no session key is valid.

PoP answers three questions for any observer:

1. **Where** is the Wanderer right now (or is it traveling / sleeping)?
2. **Is this output authentic** for the claimed Door and epoch?
3. **Was presence ever violated** (two Doors claiming the same epoch)?

This document is the authoritative PoP spec for Ghost (`pop/0.1`). It is designed to be implementable without reading ARCHITECTURE.md or WHITEPAPER.md, though those documents motivate the design.

Every soulchain record that touches PoP MUST include `pop_version: "pop/0.1"` in its attestation body (see OSP records `attestation` schemas).

---

## 2. Terminology

| Term | Meaning |
|------|---------|
| **Soul key** | Long-lived Ed25519 identity key. Signs soulchain records and authorizes session keys. |
| **Session key** | Short-lived Ed25519 subkey for one residency epoch. Signs all live Door traffic. |
| **Door** | A host adapter with its own Ed25519 identity key (`door_id`). |
| **Epoch** | Monotonic residency counter. Increments on every arrival at a new Door. |
| **Residency** | The pair `(door_id, epoch)`, encoded in records as `door:<door_id>/epoch:<n>` (example: `door:discord:guild123/epoch:77`). |
| **Attestation** | A soulchain `attestation` record (`body.kind`: `arrival`, `heartbeat`, `departure`, `travel`, or future `handover`). |
| **Traveling** | The public state between `departure`/`travel` and the next `arrival`: no valid session key exists. |

---

## 3. Soul key (v0.1)

### 3.1 Custody

In Ghost, the soul key is a **single Ed25519 keypair** held on the host running the runtime.

- The private key is loaded from a filesystem path supplied by an environment variable (name and format are deployment-specific; see `ops/SECRETS.md` when published).
- The public key is the Wanderer's permanent identity and appears in the genesis record.
- **Ghost implementers MUST NOT implement threshold signatures, TEE enclaves, or multi-party custody.** Those are future work (see §9).

### 3.2 Keyring interface

All runtime code that needs signing MUST go through a **`Keyring` interface** that abstracts custody:

- `signWithSoulKey(payload) → signature`
- `deriveSessionKey(door_id, epoch) → { publicKey, sign(payload) → signature }`
- `getSoulPublicKey() → publicKey`

Callers (session loop, handover, heartbeat writer) MUST NOT read key files or assume single-key custody. The v0.1 implementation behind `Keyring` is one key on disk; v0.3+ may swap in threshold custody without changing callers (ENGINEERING.md D5).

### 3.3 What the soul key signs

- Every soulchain record (`sig` field).
- Session-key authorization at arrival (`body.kind: "arrival"` includes the new session public key; soul key signs the record envelope).
- Departure and travel attestations (`body.kind: "departure"` / `"travel"`).

---

## 4. Session key (v0.1)

### 4.1 Derivation

At the start of each residency epoch, the runtime derives a **new Ed25519 session keypair** as a deterministic subkey from:

- soul key material (via `Keyring`),
- `door_id` of the hosting Door, and
- `epoch` number.

The derivation function MUST be deterministic (no `Math.random()`, no wall-clock time). The exact algorithm and test vectors live in `spec/pop/vectors/` (added with the first implementation PR). Implementations MUST match those vectors.

### 4.2 Binding

A session key is **bound** to exactly one residency: `(door_id, epoch)`.

- Verifiers MUST reject session-key signatures on payloads that claim a different `door_id` or `epoch`.
- Only one session key is valid per epoch globally. A new epoch (incremented at arrival) retires the previous session key.

### 4.3 Publication

The session public key is **published in the `arrival` attestation** for that epoch. Until that record is appended and verified, no session key is considered valid for the epoch.

### 4.4 What the session key signs

All **live Door outputs** during an active residency:

- Every message the runtime sends on the Door session WebSocket.
- Heartbeat attestation payloads (alongside the Door's own signature — see §7).

Replica shrines and widgets verify outputs by checking the session-key signature against the key published in the latest `arrival` attestation for the current epoch.

---

## 5. Residency lifecycle

A residency epoch progresses through three public states:

```
  ┌─────────────┐  departure    ┌───────────┐   arrival    ┌─────────────┐
  │  PRESENT    │ ────────────► │ TRAVELING │ ───────────► │  PRESENT    │
  │ (session    │   (+ travel)  │ (no valid │              │ (new session│
  │  key valid) │               │  session  │              │  key)       │
  └─────────────┘               │  key)     │              └─────────────┘
                                └───────────┘
```

| State | Valid session key? | Atlas banner |
|-------|-------------------|--------------|
| **Present** | Yes — for `(door_id, epoch)` | `present` + current `door_id` |
| **Traveling** | No | `traveling` |
| **Sleeping** | No | `sleeping` (out of PoP scope; see OSP `sleep` records) |

---

## 6. Manual handover (v0.1)

Ghost uses **operator-orchestrated manual handover**. There is no autonomous Navigator or threshold rotation ceremony in v0.1.

### 6.1 Operator flow

The operator runs a CLI command (e.g. `wanderer move <door>`) that orchestrates:

1. **Depart** at the current Door.
2. **Travel** — gap with no valid session key.
3. **Arrive** at the next Door.

The runtime MUST NOT accept Door session traffic during the travel gap.

### 6.2 Attestation sequence (`body.kind`)

Handover produces a sequence of soulchain `attestation` records. In v0.1 these are **separate records** (not a single `handover` record), each with `type: "attestation"` and `body.kind` as defined in `spec/osp/records.md`:

| `body.kind` | When | Signers | Purpose |
|-------|------|---------|---------|
| `departure` | End of residency at old Door | Soul key + departing Door key (`cosigners`) | Closes epoch *n*; session key for epoch *n* is retired. (Narrative alias: farewell.) |
| `travel` | Immediately after departure | Soul key | Marks public traveling state; explicitly asserts no session key is valid. |
| `arrival` | Start of residency at new Door | Soul key + arriving Door key (`cosigners`) | Opens epoch *n+1*; publishes new session public key. (Narrative alias: welcome.) |

**Epoch rule:** `departure` and `travel` reference epoch *n*. `arrival` references epoch *n+1* (monotonic increment).

Every attestation body MUST include `pop_version: "pop/0.1"` (see OSP records).

### 6.3 Depart responsibilities

On depart, before the `departure` attestation:

- Distill the residency into candidate memory shards.
- Run the cosign flow at the Door (`POST /door/cosign`).
- Append cosigned `memory` records, then `departure`, then `travel`.

### 6.4 Arrive responsibilities

On arrive:

- Increment epoch.
- Derive the new session key for `(new_door_id, new_epoch)`.
- Append the `arrival` attestation containing the session public key.
- Begin heartbeat timer and accept Door session traffic.

### 6.5 Future: threshold rotate ceremony

The full handover ceremony in the long-term design is:

```
depart(old_door_sig) → rotate(soul_key threshold sig) → arrive(new_door_sig)
```

**v0.1 does not implement `rotate`.** The `travel` attestation satisfies the public gap; threshold soul-key rotation is specified in PoP v0.2+ (TASKS.md T7.3, T7.9). Ghost implementers MUST NOT build threshold signing or custodian quorum logic.

---

## 7. Heartbeats

### 7.1 Cadence

During an active residency (present state), the runtime emits heartbeat attestations on a timer at **approximately 10-minute cadence**. The exact interval is injectable in tests; production default is 10 minutes.

Each heartbeat is:

1. Appended to the soulchain as an `attestation` record with `body.kind: "heartbeat"` (fields per OSP records).
2. Sent to the Door via `POST /door/heartbeat` (Door API spec) — Door returns a Door-key signature that is recorded in the soulchain record's `cosigners`.

### 7.2 Signatures

Every heartbeat MUST be dual-attested:

| Signer | Where | Proves |
|--------|--------|--------|
| **Soul key** | Record envelope `sig` | Chain integrity / authority to claim presence. |
| **Session key** | Door API heartbeat request `sig` (and binding via `session_pubkey` in body) | The runtime holding the active session for `(door_id, epoch)`. |
| **Door key** | Record `cosigners` (from Door heartbeat response) | The host Door is actually serving and relaying the heartbeat. |

A soulchain heartbeat without a Door co-signature is invalid. A Door API heartbeat without a valid session-key signature is invalid.

### 7.3 Heartbeat body (minimum fields)

Per OSP records `kind: "heartbeat"`: `pop_version`, `door_id`, `epoch`, `session_pubkey` (must match the `arrival` for this epoch), `at`.

---

## 8. Violation detection

### 8.1 Conflict definition

A **presence conflict** is machine-checkable evidence that two Doors claimed valid presence in the **same epoch**:

> Two valid heartbeat (or other presence) attestations for **different `door_id` values** with the **same `epoch`**, both passing signature verification.

### 8.2 What verifiers check

Given a set of attestations for epoch *e*:

1. Verify soul-chain linkage and record signatures.
2. Verify session-key and Door-key signatures on each heartbeat.
3. Confirm each attestation's `session_pubkey` matches the `arrival` attestation for epoch *e*.
4. If any two attestations have different `door_id` values → **conflict**.

No human judgment is required. The Atlas (v0.2+) will expose a violation log; in Ghost, `osp verify` and test tooling MUST detect conflicts over fixture chains.

### 8.3 Deterrent (informative)

PoP's security model assumes public, permanent recording of conflicts and reputational consequences (custodians refusing future rotations to a violating operator). Ghost records the cryptographic proof; social enforcement is out of scope for v0.1.

---

## 9. v0.1 non-goals

The following are **explicitly out of scope** for `pop/0.1`. Ghost implementers MUST NOT build them:

| Non-goal | Planned for |
|----------|-------------|
| **TEE custody** (soul key inside an enclave) | v0.x fallback in long-term design; not Ghost |
| **Threshold / multi-party soul-key custody** (t-of-n) | v0.3+ (TASKS.md T7.9) |
| **On-chain anchors** for heartbeats or attestations | v0.x (TASKS.md T7.6); Ghost uses local file anchoring only |
| **Automated threshold rotate ceremony** during handover | PoP v0.2 (TASKS.md T7.3) |
| **Atlas violation log UI** | PoP v0.2 |
| **Conflict-proof submission API** | PoP v0.2 |

Implementers SHOULD design the `Keyring` interface and attestation record shapes so these features can be added without breaking v0.1 chains.

---

## 10. Verification checklist

An implementation conforms to `pop/0.1` if:

1. Soul key is a single Ed25519 key on the host, accessed only via `Keyring`.
2. Session keys are derived per `(door_id, epoch)` and published in `arrival` attestations.
3. All live Door outputs are signed with the active session key.
4. Manual handover produces `departure` → `travel` → `arrival` attestations; no session key is valid during travel.
5. Heartbeats fire at ~10 min cadence with session + Door signatures.
6. Conflicting heartbeats (same epoch, different doors) are detected automatically.
7. No threshold, TEE, or on-chain anchor code paths exist.

Conformance test vectors in `spec/pop/vectors/` are the final arbiter when this prose and an implementation disagree.

---

## 11. Related specifications

- **OSP records** (`spec/osp/records.md`) — `attestation` record envelope and soulchain rules.
- **Door API** (`spec/door/api.md`) — `hello`, `session`, `heartbeat`, `cosign` endpoints.
- **ARCHITECTURE.md §3** — motivational overview (threshold/TEE described there as long-term, not Ghost requirements).

---

## Revision history

| Version | Date | Notes |
|---------|------|-------|
| `pop/0.1` | 2026-07-20 | Ghost scope: single key, manual handover, heartbeats, conflict detection. |
