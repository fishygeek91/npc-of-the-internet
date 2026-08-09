# Privacy, retention, and right-to-erasure (Gate E1)

**Status:** Normative for public replication of `memory` / journal content.  
**Decision date:** 2026-07-28 (owner: @fishygeek91).  
**Gate:** Blocks T7.1 Phase D (public IPFS push). See also [`ipfs-store.md`](./ipfs-store.md) §7.

This document is a design and ops policy for the project. It is **not legal advice**. Human review against GDPR/CCPA-style obligations remains required before a real public launch.

---

## 1. Decision

**Option (b) — text-off-chain-by-reference (`osp/0.2`), with durability by default.**

- Shard and journal **prose** move to **side blobs**. The soulchain stores a blob CID + content hash (and the usual signed envelope).
- **Erasure** = delete/unpin the blob from infrastructure we control; the chain keeps a **verifiable tombstone** (something was erased here, when, and a **category-level reason** — never the erased content).
- **Durability by default:** blobs are pinned and retained indefinitely. Deletion is an *exceptional, on-chain-visible* event. Erasure is public and auditable, not a silent edit.

Option (a) (immutability of shard text on-chain forever) is **rejected for now**. It remains reachable later via an explicit sealing ceremony after stronger screening exists (see §9).

Schema/format work for `osp/0.2` is **not** defined here — record, tombstone, and side-blob shapes are normative in [`records.md`](./records.md) (`osp/0.2`). See also follow-up issue [#119](https://github.com/fishygeek91/npc-of-the-internet/issues/119). Until that lands, Ghost continues to use `osp/0.1` local storage; **no public push of memory text** until Phase D is unblocked by this gate *and* operators configure replication.

---

## 2. Rationale

- The immutable part of the vision is the **chain** (identity, history, signatures, cosigns). That remains fully preserved under (b). Distilled prose comes from real humans' messages; making that prose permanently unerasable is a liability, not a feature.
- **(b) contains (a), but (a) can never become (b).** "Never delete blobs" as policy gives de facto immutability, upgradeable later to true per-shard sealing. Shipping (a) first forecloses every future option.
- Committing to permanent immutability while the PII screen is a small static heuristic set is sequencing backwards. Graduate to sealing after the immune system is real (T7.4) and residencies have been observed.
- A public, verifiable erasure trail on an otherwise permanent identity ledger is itself a novel mechanism — more differentiating than raw immutability of every word.

---

## 3. What is collected

During a residency through a Door:

- **Public messages** and related Door events in the residency channel (as delivered by the Door implementation).
- **Session context** may be sent to the configured **Brain** provider for live replies and for end-of-residency distillation / journal generation.
- **Operator review** decisions over candidate shards (accept / reject / edit) as required by the Door cosign flow.

The project does not intend to build a surveillance archive of private individuals. Distillation aims for short, first-person shards without PII unless the cosigning host explicitly approves an identifier for that shard (charter: [`genesis.md`](./genesis.md)).

---

## 4. Retention

| Data | Retention |
|------|-----------|
| Raw residency **transcripts** | May exist on disk **during** a residency. At depart, the transcript is **read once and destroyed** (see ARCHITECTURE Distiller; runtime destroys the source after read). Not stored on the soulchain. |
| In-process depart retry cache | Lines may remain in process memory only for in-process depart retries; a process crash cannot re-read a destroyed transcript file. |
| Distilled **memory shards** / **journals** | Durable outputs. Under `osp/0.1` text is inline on-chain; under `osp/0.2` ([#119](https://github.com/fishygeek91/npc-of-the-internet/issues/119)) text lives in side blobs referenced by the chain. |
| Soulchain **envelopes** (CIDs, signatures, cosigns, attestations, tombstones) | Append-only; retained indefinitely. |

Defensible phrasing (aligns with ARCHITECTURE and #75 A.4): transcripts are not “never written”; they are **destroyed after the residency ends** (specifically at depart read), not kept as a long-term archive.

**Crash-orphaned transcripts:** destroy runs at depart-read. If the runtime crashes mid-residency, the transcript file can remain on disk until a later successful depart (or indefinitely if that residency never resumes). Operators should treat residual transcript files under the residency data directory as sensitive and delete them on recovery; a startup sweep may be added as ops follow-up (not required for this gate).

---

## 5. On-chain vs blobs

| Artifact | Public / durable identity | Erasable prose |
|----------|---------------------------|----------------|
| Record envelopes, `prev` links, signatures, cosigns | Yes — soulchain | — |
| Blob CID + hash on the envelope (`osp/0.2`) | Yes — chain | — |
| Blob bytes (shard/journal text) | Availability via pins | Yes — delete/unpin + tombstone |
| Arweave / cold snapshot | **Envelope blocks only** under (b) | Never text blobs ([`ipfs-store.md`](./ipfs-store.md) §9) |

Unpinning from services we control **reduces availability**; it does **not** erase volunteer copies already held elsewhere ([`ipfs-store.md`](./ipfs-store.md) §5.3). The policy is honest about that asymmetry — which is why public push waits on this gate.

---

## 6. Erasure and tombstones

1. Operator or requester opens a privacy request (see §7).
2. Maintainers review. If granted for erasable blob text: delete/unpin the blob from infrastructure we control; append a **tombstone** record (shape defined in [`records.md`](./records.md) §Type: `tombstone`) with a category-level reason — never the erased content.
3. Chain history remains verifiable: the identity ledger still shows that a memory existed and was later erased.
4. Volunteer IPFS copies cannot be recalled. Announcements should not claim global erasure.

Until `osp/0.2` exists, erasure of local/`osp/0.1` content is operational (VPS + private backup) and must still be handled carefully; **do not** start public memory replication before `#119` lands and Phase D is explicitly configured.

---

## 7. How to request removal (takedown contact)

**Canonical contact is GitHub-native. No personal email addresses are published in this repository.**

Takedown and erasure requests: open a privacy-labeled issue at https://github.com/fishygeek91/npc-of-the-internet/issues/new?template=privacy-takedown.md. Requests are reviewed by the repo maintainers. Private/sensitive reports: use the repository's private security reporting form.

Use the **Privacy / takedown** issue template (label `privacy`). Provide:

- Content identifier (CID and/or post ID)
- Reason (erasure request, DMCA, or illegal content)
- Your relationship to the content

Filing a **public** issue can re-publicize sensitive material. Prefer the **private security reporting** form for erasure requests that should not appear on the public issue tracker. A private email channel will be added before public launch; until then, private security reporting is the sensitive path.

---

## 8. Takedown policy limits

- We can act on infrastructure we operate (runtime host, configured pinning services, private backups).
- We cannot force deletion of copies held by independent volunteer pinners or third-party mirrors.
- DMCA / illegal-content reports are reviewed under applicable law; this doc does not expand statutory process.
- Frivolous or abusive requests may be closed with rationale.

---

## 9. PII screen scope

The v0.1 **static immune screen** (`packages/immune`) is **best-effort**: heuristic categories such as email, phone, and `@handle`, plus injection patterns. It is **not** a complete name/doxx detector.

Under decision (b):

- The **erasure path** is the primary control for residual personal data that slips into durable shards.
- Stronger name/doxx screening belongs in the **Brain distill contract** and the **T7.4 verifier ensemble**, not an ever-growing regex list in the static screen.
- Charter hard constraint `no-pii-in-shards` still applies; host cosign approval remains the exception path for identifiers.

---

## 10. Third-party processors

LLM completions go through the runtime `Brain` interface. Ghost’s **current** default implementation is the **Anthropic** API (`ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_FILE`, model via `NPC_BRAIN_MODEL` — see [`ops/SECRETS.md`](../../ops/SECRETS.md)). The interface is provider-agnostic; retention rules above do not depend on which provider is configured. If the default Brain changes (e.g. multi-provider / budget tiering), update the named default in this section in the same PR. Message content and distillation prompts may be sent to the configured provider under their terms.

---

## 11. Future path (non-binding)

After T7.4 (verifier ensemble) is live and residencies have been observed, an explicit **seal** ceremony may make chosen shards immutable per-record. That would be a **new** gated decision — not implied by this document.

---

## 12. Related work

| Item | Where |
|------|--------|
| Charter privacy voice | [`genesis.md`](./genesis.md) |
| IPFS store / unpin honesty | [`ipfs-store.md`](./ipfs-store.md) §5.3, §7 |
| `osp/0.2` schema + tombstones | [`records.md`](./records.md) (`osp/0.2`); [#119](https://github.com/fishygeek91/npc-of-the-internet/issues/119) |
| Door host disclosure template | [`ops/templates/announcement.md`](../../ops/templates/announcement.md) |
