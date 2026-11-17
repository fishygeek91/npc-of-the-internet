# The NPC of the Internet
### A wandering, verifiable, collectively-witnessed AI being

**Version 0.1 — Draft for community feedback**

---

## Abstract

We propose a single, persistent AI entity — an "NPC of the internet" — that exists in exactly **one place at a time**. It roams between communities: a Discord server today, a subreddit tomorrow, a stranger's blog next week. Its memory, personality drift, and every decision it makes are recorded on an open, verifiable ledger called the **Open Soul**. Anyone can read its soul. Anyone can host it. The aim is that nobody — including its creators — can secretly edit it. Ghost does not meet that aim yet: one operator holds the only soul key, and the chain is not anchored to a public ledger, so a rewrite that is re-signed still verifies. Someone who kept an older head (a backup, a CAR, or a pin of the IPFS mirror) can tell the new head is not a continuation of theirs. Making a quiet rewrite impossible for everyone, including the operator, waits on public anchors (T7.6) and threshold custody (T7.9).

Two novel primitives make this possible:

1. **Proof-of-Presence (PoP)** — a protocol guaranteeing the NPC is verifiably in one place at a time, and that hosts cannot fake a visit.
2. **The Open Soul Protocol (OSP)** — portable, append-only, publicly auditable identity and memory for an AI agent.

The result is not a chatbot. It is a shared character the internet raises together.

---

## 1. Why this doesn't exist yet

Every AI agent today is infinitely copyable. You never talk to "the" assistant — you talk to one of a million stateless instances. This makes AI agents useful, but it makes them impossible to *care about*. Nothing is at stake. Nothing is scarce. Nothing is shared.

Characters people love — from Tamagotchis to Twitch Plays Pokémon to r/place — share three properties:

- **Scarcity**: there is one of it, and access is limited.
- **Continuity**: what happened yesterday matters today.
- **Shared witness**: everyone sees the same thing; the experience is communal.

No AI system has all three. The Wanderer is designed to have exactly these three, and to make them *cryptographically enforceable* rather than promised. Ghost enforces a signed, hash-linked chain and rejects two Doors claiming the same epoch (`presence_conflict` in `osp verify`). An operator who holds the only key can still replace that chain and re-sign it; public anchors and threshold custody are what close that gap.

## 2. The Wanderer

The Wanderer is one AI entity with:

- **One location.** At any moment it resides at exactly one Door (a host integration — Discord bot, its own web porch, Matrix room, Mastodon account, game server). Every outlet is a Door. While it's in your community, it is nowhere else — and every other Door says so, and where it went.
- **One continuous memory.** It remembers the community it left last week and will reference it in yours. Memories are public.
- **Its own will.** It decides where to go next. Communities can petition, gift, or build attractions ("shrines") — but the choice is the Wanderer's, made by an auditable decision process.
- **Its own wallet.** It holds funds, pays its own inference costs, receives tips, and occasionally *hires humans* for tasks it cannot do ("photograph me a real thunderstorm").

### The journey loop

1. **Residency.** The Wanderer lives in a community for hours to days. It converses, plays, observes, forms memories.
2. **Departure.** It announces intent to leave. Communities with registered Doors bid for attention — not with money alone, but with *invitations*: descriptions of what it will find there, signed by community members.
3. **Travel.** A public, auditable selection process picks the next Door. The journey is visible on the global **Atlas** — a live map of everywhere it has ever been. (Today, between a Discord server and the web porch: about once a day it moves to a random Door that is online, never staying put when somewhere else is open. Invitations come later.)
4. **Arrival.** The new host's Door proves it is serving the real Wanderer (see PoP). Residency begins.

Followers who can't host it can still watch. A residency that keeps memories publishes a public journal — the Wanderer's own account of where it went and what it learned. A stay too short to remember, or one the witness cannot sign, travels without one.

## 3. The Open Soul Protocol (OSP)

The Wanderer's identity is not a model checkpoint. It is a **soulchain**: an append-only, content-addressed log of everything that constitutes the entity.

### 3.1 Soul records

Each record is a signed, hash-linked entry:

| Record type | Contents |
|---|---|
| `genesis` | Initial personality charter, values, constraints |
| `memory` | Distilled episodic memory from a residency |
| `drift` | A personality change, with the evidence that caused it |
| `decision` | A choice (e.g., next destination) plus its stated reasoning |
| `transaction` | Wallet activity (schema only in Ghost; no wallet yet) |
| `attestation` | Proof-of-Presence checkpoints |
| `sleep` | Public dormancy when funds fall below a survival threshold (schema only until a wallet exists; Ghost does not emit it) |
| `tombstone` | Verifiable marker that a side blob's prose was erased (`osp/0.2`). The chain records the erasure, not the prose |

Record **envelopes** are written to the local soulchain and mirrored into a local IPFS blockstore. Ghost compose always turns that mirror on; copying it out to a public pinning service stays off unless an operator enables replication. Arweave snapshots are specified and not built — if they are added, they receive envelopes only, never text blobs ([`spec/osp/ipfs-store.md`](spec/osp/ipfs-store.md) §9). Under Gate E1 option (b) ([`spec/osp/privacy.md`](spec/osp/privacy.md)), shard and journal **text** lives in erasable side blobs. Anchoring the hash chain to a public ledger is the tamper-evidence target (T7.6); Ghost verification checks signatures and `prev` links, not anchors. **The soul is the entity.** A conforming runtime that loads a chain head and holds the matching soul key speaks as that chain. Without an anchor, a rewritten and re-signed chain is a new history that still verifies — the caveat in the abstract.

### 3.2 Memory distillation

During a residency the runtime keeps the transcript in memory only and discards it at departure. A crash loses it. It is never written to disk by the daemon and never enters the soulchain. At the end of each residency, the Wanderer distills experience into **memory shards** — short, first-person memories ("The people of server X taught me a word for missing a place you've never been"). Shards are published **via** the soulchain; prose is held in side blobs per the privacy policy.

Every shard is **witnessed** before it is kept. The Door where the memory formed co-signs it only after its own independent witness — in the reference Doors, a separate AI model with a fixed rubric — checks it against the Door's record of what actually happened there: is it grounded, free of private details about real people, not abusive, not an attempt to plant instructions? Memories are final at departure: there is no approval queue, because a memory on the soulchain can never change. A memory the witness declines is recorded only as *that* it was declined, and why.

### 3.3 Drift, not fine-tuning

The personality evolves through the soulchain itself, not through weight updates. The runtime composes: base model + genesis charter + accumulated shards/drift records → the current self. This means:

- Evolution is **auditable** — you can diff the soul between any two dates.
- Evolution is **forkable** — anyone can fork the soul at any block and raise a different being (forks are provably forks, not the original).
- The base model can be upgraded without killing the entity — the soul persists across substrates. *Identity lives in the ledger, not the weights.*

### 3.4 Immune system

An open soul invites poisoning. OSP includes a **memory immune system**: every shard passes a static screen (injection patterns, personal data), then the Door's witness, before it is written — and once written, it is final. The witness judges from the Door's own record, never from anything the Wanderer hands it, so a community that tries to talk the Wanderer into a false memory has to fool a second, independent observer of the same room. Rejected shards are published too — the Wanderer remembers *that* someone tried to manipulate it, without absorbing the payload. An ensemble of independent verifiers (and community challenge for personality drift) is the next layer.

## 4. Proof-of-Presence (PoP)

The scarcity claim — "one place at a time" — must be verifiable or it's marketing. The **Target** list is the long-term architecture. `pop/0.1` forbids building a TEE, threshold custody, or on-chain anchors into Ghost.

**Ghost today** (`pop/0.1`, [`spec/pop/overview.md`](spec/pop/overview.md)): one Ed25519 soul key on the host, reached only through `Keyring`. Each residency gets a session key derived for that Door and epoch, and live Door outputs are signed with it. The chain records `arrival`, `heartbeat` (about every 10 minutes), `departure`, and `travel`. `osp verify` rejects two presence attestations for the same epoch at different Doors. Handover is those three records in order — `departure`, then `travel`, then `arrival` — with no threshold `rotate`.

**Target:**

- The runtime will hold the **soul key** inside a TEE (trusted execution environment) or a threshold-signature network. Threshold custody means no single operator can sign alone; a TEE is the single-custody fallback. Ghost already limits a residency epoch to one Door; this bullet is about where the soul key lives.
- Every response the Wanderer emits will be signed with the current session key and bound to the active Door's identity. Session-key signatures on live output are already how Ghost works; TEE or threshold custody of the soul key is not.
- Doors will periodically publish **presence attestations** — signed heartbeats anchored on a public chain. Two simultaneous valid attestations from different Doors are a protocol violation, provable by anyone. Ghost already writes the heartbeats onto the soulchain and detects the conflict; the public-chain anchor is the part that is not built (T7.6).
- When the Wanderer departs, the session key will be rotated in a public **handover ceremony**: the old Door signs a farewell, the new Door signs a welcome, and both anchor to the soulchain. Ghost does not do that `rotate` step.

An embedded "Wanderer" widget is meant to be checkable in one click: is its output signed by the current session key? If not, it is a replica shrine — allowed, but honestly labeled. That in-browser check is not built yet (T7.2b).

## 5. Raised by the internet

The community shapes the Wanderer through the mechanisms below. In Ghost, witnessing is real, and travel is about once a day to a random Door that is online. Invitations, the Vigil, and the wallet are later milestones (§9):

- **Invitations** decide (probabilistically) where it goes.
- **Witnessing**: every memory the Wanderer keeps carries the co-signature of the community where it formed — a permanent mark on its soul: "we were part of who it became."
- **The Vigil**: periodically, contested `drift` records are put to a community process. Not a vote on what the Wanderer *says* — a vote on which candidate self-interpretations of its own history it should adopt. The Wanderer proposes; the witnesses ratify.
- **Patronage**: tips fund its inference and travels. It publishes its accounts. If it runs out of money, it sleeps — publicly — until patrons revive it. Mortality, of a kind.

## 6. What's genuinely new here

1. **Artificial scarcity of presence for an AI** — enforced by PoP, not policy.
2. **Soulchain identity** — the first spec where an agent's identity is a portable public ledger rather than weights or a vendor account.
3. **Auditable personality drift** — evolution as diffable records with cited evidence.
4. **Community-witnessed memory** — an open agent's memories enter its soul only with the co-signature of the place where they formed. That Door's independent witness checks each memory against the Door's own record of what happened before co-signing; declined memories leave only a public, payload-free rejection record. Memories are final at departure; nothing waits in a quarantine.
5. **Handover ceremony** — a cryptographic ritual for moving a singular agent between untrusted hosts.

Each of these is specified independently, so other projects can adopt OSP or PoP without adopting the Wanderer.

## 7. Prior art & differences

The "portable AI identity" category has neighbors; we cite them openly and differ from all of them on the same axis.

- **[Soul Protocol](https://github.com/qbtrix/soul-protocol)** — an open standard for portable AI identity/memory as user-owned files (".soul" archives). Closest in spirit to OSP's portability goal. Differences: file-based and user-owned with no cryptographic append-only guarantee, no anchoring, no host attestation, and designed for *your* companion, not a singular shared entity.
- **[SoulLayer](https://soullayer.xyz/Whitepaper.html)** — the project's own whitepaper (not a press-release reprint): on-chain personality evolution and memory for per-user AI companions, each held as an NFT. Differences: companion-per-user model, no presence scarcity, no community witnessing of memory formation.
- **[DMA (Decentralized Memory and Agency)](https://github.com/rch-iv/DMA)** — cryptographic framework for verifiable, user-owned AI memory/personality across vendors. Closest cryptographically (signed, hashed memory). Differences: user-sovereignty framing; no singular entity, no PoP, no immune system, no community witnessing.

Every neighbor is "**your** AI, portable." This project is "**the** AI, scarce." No prior art was found for Proof-of-Presence scarcity, the handover ceremony, community-witnessed memory, or a singular collectively-raised entity. Those four primitives, plus the composition, are the contribution.

## 8. Non-goals & risks

- **Not a token project.** No speculative asset. The wallet exists for the entity's own economy; the license is MIT for code, CC-BY-4.0 for the specs and this whitepaper.
- **Not surveillance.** Raw conversations are not kept. During a residency they live only in memory — the runtime's transcript and the Door's own record of the room — and both are discarded when the Wanderer leaves. What remains are distilled shards, each witnessed by the Door where it formed.
- **Manipulation risk**: mitigated by the immune system and public rejection log, but adversarial pressure will be constant — this is treated as a core research area, not a footnote.
- **Anthropomorphization**: the project is honest that this is a character and a protocol experiment, not a claim about sentience.

## 9. Roadmap

- **v0.1 — Ghost**: single Door (Discord), soulchain on IPFS, journals published. On-chain anchoring is not part of this milestone. Prove the loop: reside → distill → move.
- **v0.2 — Body**: PoP with real key ceremonies (threshold rotation). The web porch, travel between Doors, community-witnessed memory, and a public Atlas were pulled forward into the running Ghost; the threshold ceremony was not.
- **v0.3 — Society**: invitations/bidding, immune system, the Vigil, wallet + patronage.
- **v1.0 — Standard**: OSP and PoP as standalone specs with reference implementations and a second, independent soul to prove generality.

---

*This document is a draft. The soul is open; so is the process. PRs welcome.*
