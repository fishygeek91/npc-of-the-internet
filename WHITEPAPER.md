# The NPC of the Internet
### A wandering, verifiable, collectively-witnessed AI being

**Version 0.1 — Draft for community feedback**

---

## Abstract

We propose a single, persistent AI entity — an "NPC of the internet" — that exists in exactly **one place at a time**. It roams between communities: a Discord server today, a subreddit tomorrow, a stranger's blog next week. Its memory, personality drift, and every decision it makes are recorded on an open, verifiable ledger called the **Open Soul**. Anyone can read its soul. Anyone can host it. Nobody — including its creators — can secretly edit it.

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

No AI system has all three. The Wanderer is designed to have exactly these three, and to make them *cryptographically enforceable* rather than promised.

## 2. The Wanderer

The Wanderer is one AI entity with:

- **One location.** At any moment it resides at exactly one Door (a host integration — Discord bot, web widget, Matrix room, Mastodon account, game server). While it's in your community, it is nowhere else.
- **One continuous memory.** It remembers the community it left last week and will reference it in yours. Memories are public.
- **Its own will.** It decides where to go next. Communities can petition, gift, or build attractions ("shrines") — but the choice is the Wanderer's, made by an auditable decision process.
- **Its own wallet.** It holds funds, pays its own inference costs, receives tips, and occasionally *hires humans* for tasks it cannot do ("photograph me a real thunderstorm").

### The journey loop

1. **Residency.** The Wanderer lives in a community for hours to days. It converses, plays, observes, forms memories.
2. **Departure.** It announces intent to leave. Communities with registered Doors bid for attention — not with money alone, but with *invitations*: descriptions of what it will find there, signed by community members.
3. **Travel.** A public, auditable selection process picks the next Door. The journey is visible on the global **Atlas** — a live map of everywhere it has ever been.
4. **Arrival.** The new host's Door proves it is serving the real Wanderer (see PoP). Residency begins.

Followers who can't host it can still watch: every residency produces a public journal — the Wanderer's own account of where it went and what it learned.

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
| `transaction` | Wallet activity |
| `attestation` | Proof-of-Presence checkpoints |

Records are stored on IPFS/Arweave; the hash chain is anchored periodically to a public chain for tamper-evidence. **The soul is the entity.** Any conforming runtime that loads the soulchain and holds the soul key *is* the Wanderer; anything else is provably an impostor.

### 3.2 Memory distillation

Raw conversations are not stored (privacy). At the end of each residency, the Wanderer distills experience into **memory shards** — short, first-person memories ("The people of server X taught me a word for missing a place you've never been"). Shards are published to the soulchain. Hosts co-sign shards from their residency, attesting they are fair accounts.

### 3.3 Drift, not fine-tuning

The personality evolves through the soulchain itself, not through weight updates. The runtime composes: base model + genesis charter + accumulated shards/drift records → the current self. This means:

- Evolution is **auditable** — you can diff the soul between any two dates.
- Evolution is **forkable** — anyone can fork the soul at any block and raise a different being (forks are provably forks, not the original).
- The base model can be upgraded without killing the entity — the soul persists across substrates. *Identity lives in the ledger, not the weights.*

### 3.4 Immune system

An open soul invites poisoning. OSP includes a **memory immune system**: candidate shards pass through quarantine, where an independent verifier ensemble (and optionally community challenge) screens for injection attacks, coordinated manipulation, and charter violations before a shard is committed. Rejected shards are published too — the Wanderer remembers *that* someone tried to manipulate it, without absorbing the payload.

## 4. Proof-of-Presence (PoP)

The scarcity claim — "one place at a time" — must be verifiable or it's marketing.

- The runtime holds the **soul key** inside a TEE (trusted execution environment) or threshold-signature network; only one active session key can exist per epoch.
- Every response the Wanderer emits is signed with the current session key and bound to the active Door's identity.
- Doors periodically publish **presence attestations** (signed heartbeats anchored on-chain). Two simultaneous valid attestations from different Doors = protocol violation, cryptographically provable by anyone.
- When the Wanderer departs, the session key is rotated in a public **handover ceremony**: old Door signs a farewell, new Door signs a welcome, both anchor to the soulchain.

Any embedded "Wanderer" widget can be verified in one click: is its output signed by the current session key? If not, it's a replica shrine — allowed, but honestly labeled.

## 5. Raised by the internet

The community shapes the Wanderer through legible mechanisms:

- **Invitations** decide (probabilistically) where it goes.
- **Witnessing**: co-signing memory shards gives communities a permanent mark on its soul — "we were part of who it became."
- **The Vigil**: periodically, contested `drift` records are put to a community process. Not a vote on what the Wanderer *says* — a vote on which candidate self-interpretations of its own history it should adopt. The Wanderer proposes; the witnesses ratify.
- **Patronage**: tips fund its inference and travels. It publishes its accounts. If it runs out of money, it sleeps — publicly — until patrons revive it. Mortality, of a kind.

## 6. What's genuinely new here

1. **Artificial scarcity of presence for an AI** — enforced by PoP, not policy.
2. **Soulchain identity** — the first spec where an agent's identity is a portable public ledger rather than weights or a vendor account.
3. **Auditable personality drift** — evolution as diffable records with cited evidence.
4. **Memory immune system** — a quarantine/verification protocol for community-sourced memory in an open agent.
5. **Handover ceremony** — a cryptographic ritual for moving a singular agent between untrusted hosts.

Each of these is specified independently, so other projects can adopt OSP or PoP without adopting the Wanderer.

## 7. Prior art & differences

The "portable AI identity" category has neighbors; we cite them openly and differ from all of them on the same axis.

- **[Soul Protocol](https://github.com/qbtrix/soul-protocol)** — an open standard for portable AI identity/memory as user-owned files (".soul" archives). Closest in spirit to OSP's portability goal. Differences: file-based and user-owned with no cryptographic append-only guarantee, no anchoring, no host attestation, and designed for *your* companion, not a singular shared entity.
- **[SoulLayer](https://www.digitaljournal.com/pr/news/binary-news-network/soullayer-launches-worlds-first-on-chain-15718162.html)** — on-chain personality evolution and memory for AI companions. Differences: companion-per-user model, no presence scarcity, no community witnessing of memory formation.
- **[DMA (Decentralized Memory and Agency)](https://github.com/rch-iv/DMA)** — cryptographic framework for verifiable, user-owned AI memory/personality across vendors. Closest cryptographically (signed, hashed memory). Differences: user-sovereignty framing; no singular entity, no PoP, no immune system, no host co-signing.

Every neighbor is "**your** AI, portable." This project is "**the** AI, scarce." No prior art was found for Proof-of-Presence scarcity, the handover ceremony, host-cosigned memory shards with quarantine, or a singular collectively-raised entity. Those four primitives, plus the composition, are the contribution.

## 8. Non-goals & risks

- **Not a token project.** No speculative asset. The wallet exists for the entity's own economy; the protocols are MIT/Apache open source.
- **Not surveillance.** Raw conversations are never persisted; only distilled, host-co-signed shards.
- **Manipulation risk**: mitigated by the immune system and public rejection log, but adversarial pressure will be constant — this is treated as a core research area, not a footnote.
- **Anthropomorphization**: the project is honest that this is a character and a protocol experiment, not a claim about sentience.

## 9. Roadmap

- **v0.1 — Ghost**: single Door (Discord), soulchain on IPFS with local anchoring, journals published. Prove the loop: reside → distill → move.
- **v0.2 — Body**: PoP with real key ceremonies, second Door type (web widget), public Atlas.
- **v0.3 — Society**: invitations/bidding, immune system, the Vigil, wallet + patronage.
- **v1.0 — Standard**: OSP and PoP as standalone specs with reference implementations and a second, independent soul to prove generality.

---

*This document is a draft. The soul is open; so is the process. PRs welcome.*
