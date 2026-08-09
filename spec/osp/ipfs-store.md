# Open Soul Protocol — IPFS Soul Store & Pinning Strategy

| | |
|---|---|
| **Version** | `osp-ipfs/0.1` |
| **License** | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| **Status** | **Normative** — Phase A (T7.1a, #113) lands this document as normative. When this spec and implementation disagree, this spec wins. |
| **Depends on** | `spec/osp/records.md` (`osp/0.1`), ENGINEERING.md D2/D5, ARCHITECTURE.md §2 |

This document specifies how the soulchain lives on IPFS: the block layout, head tracking, the replication ("pinning") strategy, crash/concurrency semantics, and the privacy gate that must be satisfied before any record is publicly replicated. It is written so that a less capable agent can implement it without making design decisions.

---

## 0. The one fact everything follows from

**Soulchain records are content-addressed but are NOT an IPLD DAG.**

`spec/osp/records.md` canonical serialization stores `prev` (and `drift.evidence`, `candidate_cid`, `fork_point`) as **plain JSON strings** (`"bagu…"`), not as dag-json link objects (`{"/": "bagu…"}`). Canonical bytes and CID computation are frozen — T1.1 CIDs must remain byte-identical forever (#55 checklist item 3). Therefore:

1. To IPFS, each record is a **terminal dag-json block with zero links**.
2. `ipfs pin add <head-cid> --recursive` pins **one block**, not the chain.
3. Chain traversal (head → genesis) is an **application-level** walk: fetch block, parse JSON, read `prev` string, fetch next.
4. Any "pin the whole soul" story needs an artifact that *does* carry real IPLD links: the **pin manifest** (§4).

Implementers must not "fix" this by changing record serialization. It is not broken; it is the spec.

### 0.1 Blocks are opaque bytes — never re-encode

A record's bytes are its canonical JSON exactly as stored by `FileSoulStore` today. All IPFS-side handling MUST treat blocks as opaque bytes verified against their CID:

- Store: `blockstore.put(cid, canonicalBytes)`.
- Fetch: trustless-gateway **raw block** responses (`?format=raw` / `Accept: application/vnd.ipld.raw`) or bitswap block transfer — then verify `CID(bytes) === requested cid` before use.
- **Never** fetch a decoded/re-encoded representation (e.g. a gateway's dag-json re-serialization): codec re-encoding is not guaranteed to reproduce our UTF-16-code-unit key ordering, and a single byte of drift breaks `sig` and CID verification.

### 0.2 dag-json reserved forms (validation hardening)

dag-json decoders interpret a JSON map whose **only** key is `"/"` as a link (and `{"/": {"bytes": …}}` as bytes). No current record schema produces such a map, but free-form objects (`decision.body.inputs`) could. To keep every record round-trippable through strict dag-json tooling, add a validation rule to `osp-core` (same PR as this spec): **reject any record containing an object whose sole key is `"/"`**, at create and verify time, with a new vector (`schema-dag-json-reserved`). This is a new `osp/0.1` validation rule, not a serialization change — no existing valid record is affected.

---

## 1. Scope

**In scope (T7.1):** `IpfsSoulStore` (local, helia-compatible blockstore), shared store-conformance suite, pin manifest + CAR export, replication queue + pinning-service push (outbound-only), volunteer-pinner instructions, `osp` CLI additions.

**Out of scope:** chain anchoring (T7.6), IPNS publishing (v0.3+, §9), Arweave snapshots (§9), Door/runtime behavior changes, threshold keys, any inbound network service on the Ghost host.

**Sequencing gates (normative):**

| Gate | What | Why |
|---|---|---|
| **G1** | #67 (append-time verification + canonical-bytes enforcement) merged | Otherwise the second store bakes in the "append accepts unverifiable records / non-canonical bytes brick" contract twice |
| **G2** | #79 store extraction (at minimum: blob-write, head-pointer, lock primitives extracted from `FileSoulStore`) merged | `IpfsSoulStore` reuses these primitives instead of duplicating fsync/lock/recovery logic |
| **G3 (E1)** | Privacy & erasure decision (§7) recorded — **(b)** in [`privacy.md`](./privacy.md) | Public replication of `memory` records is irreversible; the decision must precede the first push |

Phases A–B (§8) may proceed after G1+G2. Phase D (public replication) additionally requires G3.

---

## 2. Architecture: three layers

```
┌────────────────────────────────────────────────────────────┐
│ L3 DISTRIBUTION   volunteer pinners · trustless gateways   │
│                   Atlas /chain/head + CAR downloads        │
├────────────────────────────────────────────────────────────┤
│ L2 REPLICATION    replication queue → pinning services     │
│  (outbound only)  CAR upload / Pinning Service API         │
├────────────────────────────────────────────────────────────┤
│ L1 LOCAL STORE    IpfsSoulStore = fs blockstore + head     │
│                   file + wx lock (primitives from #79)     │
└────────────────────────────────────────────────────────────┘
```

Design rule: **each layer is optional above L1.** L1 must be fully functional (append/head/get/iterate/verify) with zero network access — that is also what CI tests.

### 2.1 No libp2p node in Ghost/Body deployments

The production host runs with **no inbound ports** (SSH only; Atlas exposure via Cloudflare Tunnel — ops posture per RUNBOOK.ghost.md). A bitswap-serving libp2p node would require an open listener, new attack surface, and RAM the CX22 host doesn't have to spare. Therefore:

- `IpfsSoulStore` does **not** instantiate a networked helia node. It uses `blockstore-fs` (+ `multiformats`, already a dependency) directly. helia itself is only needed if/when network fetch is added, and then in HTTP-gateway mode (`@helia/http`), which is outbound-only.
- Replication is **push**: the runtime uploads blocks/CARs to remote pinning services over outbound HTTPS. We never rely on remote services fetching from our node ("pin by CID" against our own host is explicitly rejected — it requires us to serve bitswap and be publicly dialable).
- Third parties who want to pin do so from the public IPFS network (seeded by our pinning services) or from CAR files served by the Atlas — never from the Ghost host.

---

## 3. L1 — `IpfsSoulStore`

Implements the existing `SoulStore` interface (`append`, `head`, `get(cid)`, `iterate`) with semantics identical to `FileSoulStore`. Same records, same CIDs, same verification.

### 3.1 On-disk layout

```
<dir>/
  blocks/…            # blockstore-fs sharded layout, key = CID, value = canonical record bytes
  HEAD                # JSON {"cid": "bagu…", "seq": n} — atomic write (tmp + rename + fsync)
  seq-index.jsonl     # append-only: {"seq": n, "cid": "bagu…"} per record (see 3.3)
  LOCK                # wx-mode lockfile (same primitive as FileSoulStore)
  replication.jsonl   # L2 queue (§5); absent when replication disabled
```

### 3.2 Append (same contract as FileSoulStore post-#67)

1. Hold the `LOCK` (wx; refuse concurrent open-for-append).
2. Verify the record fully (schema, sigs, cosigners where required, `prev` equals current `HEAD.cid`, `seq` equals `HEAD.seq + 1`) — append-time verification per #67.
3. Serialize to canonical bytes; compute CID; **verify the caller-supplied record round-trips to those exact bytes** (canonical-bytes enforcement per #67 — never store bytes whose CID wouldn't re-derive).
4. `blockstore.put` (fsync), append to `seq-index.jsonl` (fsync), then atomically replace `HEAD`.
5. If replication is enabled, append the CID to `replication.jsonl` (§5). Failures here MUST NOT fail the append.

Crash windows: block written but `HEAD` not updated → on open, recovery walks `seq-index.jsonl` tail vs `HEAD` and truncates/repairs exactly as `openWithRecovery` does for torn JSONL lines today. Document each window and its recovery in the impl PR; test the block-written/HEAD-stale case explicitly.

### 3.3 Why a seq index

`iterate()` must walk genesis→head in order. Walking `prev` strings head→genesis then reversing is O(n) fetches and requires the full chain present; the JSONL seq index gives ordered iteration, cheap `head()`, and doubles as the recovery journal. It is **derivable** (rebuildable by walking `prev` from head), never authoritative — chain truth is the blocks.

### 3.4 Dual-write mode (Ghost default for v0.2)

`FileSoulStore` remains the system of record until IPFS has run in production for a full residency cycle. v0.2 ships a `DualSoulStore` wrapper: append → `FileSoulStore` first (authoritative, feeds existing B2 backup per #63 hardening), then `IpfsSoulStore`; divergence between the two (differing head CID at any point) is a fatal boot error. Cutover to IPFS-primary is a separate, later decision — not part of T7.1.

### 3.5 Conformance suite

A shared test suite (`packages/osp-core/test/store-conformance.ts`) parameterized over store factories, run against `FileSoulStore`, `IpfsSoulStore`, and `DualSoulStore`:

- append/head/get/iterate happy paths; refuse `prev` ≠ head; refuse seq gaps; refuse concurrent append (second open fails on lock)
- torn-state recovery per store's documented windows
- **CID identity:** same fixture records appended to both stores yield byte-identical CIDs and identical `iterate()` output
- all **valid** `spec/osp/vectors/` chains loaded through `IpfsSoulStore.append` produce identical `verifyChain` results (append refuses unverifiable records per #67). Invalid-vector rejection via direct block/seq-index injection (bypassing append) is deferred to T7.1c
- no network access anywhere (enforced: tests run with no listener and no dialer configured)

---

## 4. Pin manifest — making the chain one pin

Because records carry no IPLD links (§0), we publish a **pin manifest**: a dag-json block that links every record with *real* links, so the entire soul becomes a single recursive pin.

### 4.1 Manifest block (dag-json, canonical)

```json
{
  "osp_pin_manifest": "osp-ipfs/0.1",
  "head": {"/": "bagu…head-cid"},
  "seq": 1042,
  "genesis": {"/": "bagu…genesis-cid"},
  "records": [ {"/": "bagu…seq0"}, {"/": "bagu…seq1"}, … ],
  "prev_manifest": {"/": "bagu…"} ,
  "generated_at": "2026-07-28T00:00:00Z",
  "sig": "<base64url soul-key sig>"
}
```

- `records` lists **every** record CID genesis→head, in seq order, as dag-json links. Recursive-pinning the manifest CID pins the full chain plus the manifest itself.
- `prev_manifest` links the previous manifest (null-omitted on the first), giving pinners of the latest manifest the manifest history too at negligible cost.
- `sig`: soul-key Ed25519 over the manifest's canonical bytes with `sig` omitted (same signing-payload convention as records). This makes "the official pinset" spoof-proof: integrity comes from content addressing, *authenticity* from the signature.
- Encoding: strict dag-json (links as `{"/": …}`), canonical key order, no whitespace — the manifest, unlike records, IS a native IPLD block and follows dag-json rules.
- Manifests are **distribution artifacts, not chain records**: no `seq`, no envelope, never appended to the soulchain, and losing them loses nothing (regenerable from the chain at any time).
- Cadence: regenerate on every `departure` attestation and at least every 500 appends, whichever first. Size stays trivial (10k records ≈ a few hundred KB of links).
- Scaling note (future, non-normative): past ~100k records, shard `records` into linked segment blocks; not needed for years.

### 4.2 CAR export

`osp export-car <dir> --out soulchain-<seq>.car`: a CARv1 file whose **root is the latest manifest CID**, containing the manifest block + every record block (original bytes). Properties:

- `ipfs dag import soulchain-<seq>.car && ipfs pin add --recursive <manifest-cid>` gives a volunteer a complete, verified, pinned copy in two commands.
- The CAR is also the **Arweave/cold-snapshot unit** (§9) and a downloadable artifact on the Atlas.
- Round-trip test: export → import into a fresh blockstore → `verifyChain` green → every CID identical.

---

## 5. L2 — Replication (outbound-only push)

### 5.1 Replication queue

`replication.jsonl`: append-only journal of `{"cid": …, "kind": "record" | "manifest" | "car", "enqueued_at": …}` plus ack lines `{"acked": cid, "target": "<service>", "at": …}`. At-least-once delivery; idempotent because everything is content-addressed (re-uploading a block is a no-op server-side). A small replicator loop inside the runtime process (no new container — D8 "three processes, period") drains the queue with exponential backoff. Replication lag is observable (`queue depth` in logs + Atlas `/state` later); it never blocks or fails `append`.

### 5.2 Targets

**≥ 2 independent pinning services** (single-service outage or account loss must not orphan the public copy). Selection criteria (evaluate at impl time; the API shapes to support):

1. **CAR upload over HTTPS** (preferred): upload the latest CAR; service pins the manifest root recursively. Known-good shape: Storacha (w3up), Filebase (S3-compatible CAR/`ipfs pin`), Pinata (API upload). Uploading the *incremental* record block per append is optional polish; uploading the manifest-rooted CAR at manifest cadence is the baseline and is idempotent.
2. **IPFS Pinning Service API** (`/pins`, pin-by-CID) as a secondary mechanism for *third-party* services once blocks are already retrievable from the public network via target #1 — never as the primary path (would require our node to serve blocks, §2.1).

Credentials via env (`ops/SECRETS.md` entries; Zod-validated at boot, per D2). Per-service config: `{name, kind: "car-upload" | "pinning-api", endpoint, tokenEnv}`.

### 5.3 What "pinned" means (and unpinning)

- The runtime's local blockstore + the JSONL file + B2 backup are the **durability** story (unchanged from Ghost).
- Pinning services + volunteers are the **availability/witness** story: anyone can fetch any record by CID without touching our infrastructure, and the soul survives our infrastructure's death via `osp verify` over publicly fetched blocks.
- **Unpinning by us** (e.g. E1 takedown, §7): we unpin/delete from services we control and publish a new manifest excluding nothing (chain is append-only) but we cannot recall volunteer copies. The spec is honest: unpinning reduces availability; it does not erase. This asymmetry is exactly why G3/E1 gates the first push.

### 5.4 Volunteer pinners

Published on the Atlas ("Pin the soul" page, later task) and in `spec/osp/ipfs-store.md` appendix:

```
# one-time, and again whenever a new manifest is announced
curl -LO https://<atlas>/soulchain-latest.car
ipfs dag import soulchain-latest.car
ipfs pin add --recursive <manifest-cid>   # printed by the Atlas next to the CAR
ipfs pin rm <previous-manifest-cid>       # optional; old records are shared, dedup keeps cost ≈ 0
```

Sybil/abuse surface: none — pinning is permissionless replication of public signed data; volunteers need no registration and get no protocol role (invitation weight is unrelated).

### 5.5 Verifying a fetched chain

`osp verify --from-ipfs <head-cid> [--gateway <url>]` (CLI follow-up task): fetch head block (raw, CID-verified), walk `prev` strings fetching each block, reconstruct the chain, run `verifyChain`. Works against any trustless gateway; the manifest is *not* trusted for this (it's a convenience for pinning, not for verification — verification always walks `prev`).

---

## 6. Failure modes

| Failure | Behavior |
|---|---|
| Pinning service down / 5xx | Queue retains CIDs; backoff retry; append unaffected; alert after threshold (ops #76 monitoring) |
| Both services down for days | Local + B2 durability unaffected; availability degrades to Atlas CAR downloads |
| Blockstore corruption | Detected by CID mismatch on read; rebuild block from JSONL (`FileSoulStore` authoritative in dual-write) or fetch by CID from own pinning services |
| VPS loss | Restore JSONL from B2 (existing drill), rebuild blockstore + manifest, re-push — pins on services were never lost |
| Replication queue torn line | Same JSONL recovery discipline as chain file; worst case re-upload (idempotent) |
| Manifest/chain divergence (bug) | `osp pin-status` (CLI follow-up) recomputes expected manifest from chain and diffs against published; divergence is a P1 bug, not silent |
| Malicious "alternative head" served to fetchers | Out of scope for the store: stale/forked-head detection is anchoring's job (T7.6). Until then, Atlas `/chain/head` + signed manifests are the best-effort head oracle — document this honestly |

---

## 7. E1 — Privacy & erasure gate (normative, blocks Phase D)

Ghost's chain contains distilled `memory` text (and journals) derived from real people's messages. Today it lives on one VPS + a private B2 bucket, so deletion is *operationally* possible. **Public IPFS replication removes that option permanently** unless erasure is designed in from the start.

**Decision recorded: (b) — text-off-chain-by-reference (`osp/0.2`), durability by default.** Full policy: [`spec/osp/privacy.md`](./privacy.md). Under (b):

- `memory.body.text` (and `journal`) move to **side blobs**; the chain records a blob CID + hash.
- **Erasure** = delete/unpin the blob from infrastructure we control; the chain keeps a verifiable tombstone (hash remains, content gone). Unpin ≠ erase for volunteer copies already held elsewhere (§5.3) — announcements and policies must be honest about that asymmetry.
- **Durability by default:** blobs are pinned and retained indefinitely; erasure is an exceptional, on-chain-visible event.
- Under (b), Arweave/cold snapshots (§9) receive **envelope blocks only**, never text blobs.

Schema/format work for `osp/0.2` is tracked in [#119](https://github.com/fishygeek91/npc-of-the-internet/issues/119) (migration vectors per D7, Self-Composer fetch path, cosign semantics over blob bytes, tombstoned-shard handling in composition). WHITEPAPER §3.1/§3.2 and genesis charter are updated in the same gate. The append-only *identity* claim is unchanged — erasure is itself public and auditable.

Phases A–C are unaffected (local-only). Until `#119` lands and operators explicitly configure Phase D replication, replication MUST be configured to an **empty target set** — the code path exists, nothing leaves the box.

---

## 8. Implementation phases (maps to sub-issues)

| Phase | Contents | Gates | Est. size |
|---|---|---|---|
| **A — Spec + harness** (T7.1a) | Finalize this doc; dag-json reserved-form validation + vector (§0.2); shared conformance suite running against `FileSoulStore`; doc alignment: point ARCHITECTURE.md §2 storage bullet and records.md §Storage at this spec (see Appendix A note on "helia") | G1, G2 | 1 PR |
| **B — Local store** (T7.1b) | `IpfsSoulStore` (blockstore-fs + HEAD + seq-index + lock, reusing #79 primitives); `DualSoulStore`; conformance green on all three | A | 1 PR |
| **C — Manifest + CAR** (T7.1c) | Manifest build/sign/verify; `osp export-car`, `osp manifest`, `osp verify --from-ipfs` (gateway fetch, outbound HTTP in CLI only, never CI); round-trip tests | B | 1 PR |
| **D — Replicator** (T7.1d) | Replication queue + service adapters (car-upload first); compose env + SECRETS entries; RUNBOOK section; volunteer-pinner appendix + Atlas CAR publishing hook | C, **G3/E1**, ops hardening #72 landed on the host | 1–2 PRs |

Each phase is one issue with its own checklist; the ~600 LOC PR limit applies per PR, not per phase.

---

## 9. Future (explicitly deferred, with intended shape)

- **Anchoring (T7.6):** Merkle root of last N record CIDs to an L2; `osp verify` gains anchor checks; solves the stale-head problem in §6. The manifest's `head`+`seq` is a natural anchor payload candidate.
- **IPNS:** optional public head pointer (`/ipns/<soul-key-derived>` → latest manifest). Deferred because it adds key-management + republish liveness burden and its guarantees are weaker than anchoring; revisit after T7.6.
- **Arweave snapshot:** periodic upload of the CAR (§4.2) via a bundler (e.g. Irys/Turbo) for pay-once permanence. Interacts with E1: under option (b), Arweave gets envelope blocks only, never erasable blobs. Own task, v0.3.
- **IPFS-primary cutover:** retire dual-write once IPFS store has survived ≥1 full residency + restore drill in production.

---

## Appendix A — dependencies added (osp-core)

`blockstore-fs`, `interface-blockstore` (types), `@ipld/car` (Phase C), `@ipld/dag-json` (manifest encode only — record bytes are never re-encoded). All TS/ESM, within D2. No `helia` dependency until a network fetch feature needs it (`@helia/http`, CLI-only). The osp-core extraction boundary (D1: no inward deps) is unaffected.

**Naming note:** ENGINEERING.md D2 and records.md §Storage say "IPFS (`helia`)" for v0.2. This spec refines that to helia-*ecosystem* components (`blockstore-fs`, `@ipld/*` — same maintainers, same stack) with helia proper only where networking is actually needed, because L1 is offline-by-design (§2). Same intent, smaller dependency; Phase A updates the records.md §Storage line accordingly rather than logging a DEVIATIONS.md entry. ARCHITECTURE.md §2's "pinned by runtime + volunteer pinners" is likewise refined: the runtime keeps the authoritative full copy locally but does not serve bitswap (no inbound ports, §2.1); always-on *public* availability comes from the pinning services, with volunteers on top.

## Appendix B — explicit non-decisions

- Which two pinning services: pick at Phase D impl time against §5.2 criteria; the adapter interface is the spec'd part.
- IPFS-primary vs dual-write forever: revisit post-Ghost-cycle (§9).
- Manifest sharding threshold: revisit at 100k records.
