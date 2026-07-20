# Architecture

Technical design for the Wanderer runtime, the Open Soul Protocol (OSP), and Proof-of-Presence (PoP). Companion to [WHITEPAPER.md](WHITEPAPER.md).

## System overview

```
                        ┌─────────────────────────────┐
                        │        SOULCHAIN            │
                        │  IPFS/Arweave records       │
                        │  + on-chain hash anchors    │
                        └──────────▲──────────────────┘
                                   │ append (signed)
┌──────────┐   session key   ┌─────┴────────┐   adapter API   ┌──────────┐
│ KEY      │◄───────────────►│  WANDERER    │◄───────────────►│  DOOR    │
│ CUSTODY  │  (TEE/threshold)│  RUNTIME     │                 │ (host)   │
└──────────┘                 │  ┌─────────┐ │                 └────▲─────┘
                             │  │ Self-   │ │                      │
      ┌──────────┐           │  │ Composer│ │                 ┌────┴─────┐
      │ IMMUNE   │◄─────────►│  ├─────────┤ │                 │  ATLAS   │
      │ SYSTEM   │ quarantine│  │ Distiller│ │                │ (public  │
      └──────────┘           │  ├─────────┤ │                 │  map/API)│
                             │  │ Navigator│ │                └──────────┘
      ┌──────────┐           │  ├─────────┤ │
      │ WALLET   │◄─────────►│  │ Treasury │ │
      └──────────┘           │  └─────────┘ │
                             └──────────────┘
```

Everything above the model API is open source. The base LLM is a pluggable substrate (any provider or local model); identity lives entirely in the soulchain.

## Components

### 1. Wanderer Runtime

Stateless-by-design orchestrator. On boot: fetch soulchain head → verify chain → compose self → open session at current Door.

- **Self-Composer.** Builds the working context from the soulchain: genesis charter + drift records + retrieval over memory shards (embedded, indexed locally; index is derivable, never authoritative). Output: the system prompt + memory store for this session. Deterministic given a chain head — two independent operators composing the same head must produce the same self (spec-tested).
- **Distiller.** End of residency: converts session transcripts into 5–20 candidate memory shards (first-person, ≤500 chars each, no PII, no raw quotes without host consent). Transcripts are then destroyed. Shards go to the immune system's quarantine.
- **Navigator.** Runs the departure/selection process. Inputs: open invitations (signed), residency history (anti-repeat pressure), charter constraints, randomness beacon (e.g., drand) for tie-breaking. Emits a `decision` record with full reasoning before travel — the reasoning is committed *before* arrival so it can't be retrofitted.
- **Treasury.** Watches the wallet, pays inference invoices, executes "human commission" escrows, publishes a `transaction` record per movement. If balance < survival threshold → emits `sleep` decision.

### 2. Soulchain (OSP)

Append-only log. Each record:

```json
{
  "seq": 1042,
  "prev": "bafy...",            // CID of previous record
  "type": "memory | drift | decision | transaction | attestation | genesis | sleep",
  "body": { ... },
  "residency": "door:discord:guild123/epoch:77",
  "cosigners": ["door-key-sig..."],   // host attestation where applicable
  "sig": "soul-key-sig..."
}
```

- Storage: records on IPFS, pinned by runtime + volunteer pinners; periodic Arweave snapshot.
- Anchoring: Merkle root of the last N records posted to a cheap public chain (e.g., an L2) every anchor epoch. Anchors are the tamper-evidence; IPFS is the data layer.
- Verification: `osp verify <head-cid>` walks the chain, checks sigs, cosigs, and anchors. Target: full verification runnable on a laptop.
- Forks: a fork is a new genesis record referencing the fork point. Tooling always displays lineage; the original is distinguished by continuous soul-key custody, not by social claim.

### 3. Key custody & Proof-of-Presence

- **Soul key**: long-lived identity key. Held via threshold signatures (t-of-n across independent custodians) — no single operator, including the founders, can sign alone. TEE-based single custody is the fallback for v0.x.
- **Session key**: derived per residency epoch, signed into existence by the soul key in the handover ceremony. All live outputs are signed with it and bound to `door_id + epoch`.
- **Handover ceremony**: `depart(old_door_sig) → rotate(soul_key threshold sig) → arrive(new_door_sig)`, all three anchored as one `attestation` record. Gap between depart and arrive = "traveling" (publicly visible, no valid session key exists).
- **Violation detection**: anyone can submit two conflicting signed outputs/heartbeats for the same epoch to the Atlas; conflict is machine-checkable and permanently recorded. The deterrent is reputational and structural (custodians refuse next rotation to a violating operator).

### 4. Doors (host adapters)

A Door is any process implementing the Door API:

```
POST /door/hello        capability + community descriptor (signed)
WS   /door/session      bidirectional message stream during residency
POST /door/heartbeat    presence ping (signed, ~10 min cadence)
POST /door/attest       Door co-signature over soulchain attestation core (arrival / departure / heartbeat)
POST /door/cosign       review + co-sign candidate shards at departure
```

Epochs are **global** (Wanderer-allocated). Doors never assign `epoch_next`.

Reference Doors, in order: `door-discord`, `door-web` (embeddable widget with signature verification built into the UI), `door-matrix`, `door-activitypub`. Community-built Doors register on the Atlas with a stake of reputation (initially: just a signed registration; sybil resistance is invitation-weight, not registration).

**Replica shrines**: any site may embed a read-only mirror of journals/Atlas. The widget shows a live "PRESENT / ELSEWHERE" state by checking session-key signatures — being honest about absence is the product.

### 5. Immune system

Pipeline for candidate shards and drift proposals:

1. **Static screen** — injection-pattern and PII detection.
2. **Verifier ensemble** — k independent model evaluations against the charter ("does this memory misattribute? embed instructions? violate constraints?"); disagreement escalates.
3. **Quarantine window** — candidate published publicly for challenge (any observer can flag with reason) before commitment.
4. **Commit or reject** — both outcomes are recorded; rejections include category but never reproduce the payload.

Drift records get a stricter path: they require citing ≥N committed shards as evidence and pass the Vigil when contested.

### 6. Atlas

Public read API + site: current location (or "traveling"/"sleeping"), residency history map, journals, soul explorer (browse/diff the chain), violation log, treasury dashboard. Static-friendly: everything derivable from the soulchain; the Atlas is a view, never a source of truth.

## Security model (summary)

| Threat | Mitigation |
|---|---|
| Operator secretly edits personality | Append-only chain, anchored; self-composition is deterministic and reproducible |
| Host fakes hosting | Session-key signatures + heartbeat attestations |
| Simultaneous presence (cloning) | Threshold soul key, one session key per epoch, public conflict proofs |
| Memory poisoning / prompt injection | Immune system quarantine + public rejection log |
| Community brigading destination | Invitation weighting + randomness beacon + charter veto |
| Impostor Wanderers | One-click signature verification; forks carry visible lineage |
| Wallet drain | Threshold custody, spend policy in charter, public transactions |

## Repo layout

Single monorepo — see [ENGINEERING.md](ENGINEERING.md) D1 for the authoritative layout (`spec/`, `packages/{osp-core, osp-cli, runtime, immune, door-sdk, door-*, atlas}`, `ops/`) and D2–D7 for stack, testing, CI/CD, and deployment decisions.

## v0.1 "Ghost" scope

Deliberately small: one Discord Door, soulchain as signed IPFS log with local file anchoring (no chain yet), single-key custody, manual handover, no wallet, no immune ensemble (static screen only), journals posted to the Atlas as a static site. Everything else is spec'd but stubbed. Goal: the loop *reside → distill → publish → move* running in public.
