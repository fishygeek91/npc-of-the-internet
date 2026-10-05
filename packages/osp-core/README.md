# @npc/osp-core

OSP soulchain primitives: Zod record schemas, canonical JSON, Ed25519 signing, CID computation, and record create/verify helpers. Normative prose lives in `spec/osp/records.md`.

## Public API

| Area | Exports |
|------|---------|
| Schemas | `RecordSchema`, body schemas (`GenesisBodySchema`, …), `OspRecord` types, `RESIDENCY_RE`, `parseResidency` |
| Canonical JSON | `canonicalize` — sorted keys, no whitespace (UTF-16 code-unit order) |
| Encoding | `encodeBase64Url`, `decodeBase64Url`, `encodePublicKey`, `decodePublicKey`, `encodeSignature`, `decodeSignature` |
| Ed25519 | `generateKeypair`, `sign`, `verify` |
| CIDs | `computeCid`, `computeCidFromCanonicalBytes` — dag-json codec + sha2-256 → CIDv1 base32 strings (typically `bagu…`, not `bafy…` which is dag-pb) |
| Records | `createRecord`, `verifyRecord`, `signCore`, `corePayload`, `soulPayload` |
| Door keys | `parseDoorPublicKeyBinding`, `parseDoorPublicKeyMap`, `hasDoorPublicKeys` — `doorId=base64url` bindings |
| Chain verify | `verifyRecords`, `verifyChain`, `ChainRule`, `ChainFailure`, `VerifyChainResult`, `VerifyChainOptions` |
| Pin manifest | `buildUnsignedPinManifest`, `signPinManifest`, `verifyPinManifest`, `encodePinManifest`, `decodePinManifest`, `computeManifestCid`, `listRecordCidsFromIpfsDir`, `buildAndSignPinManifestForIpfsDir` |
| CAR | `exportSoulchainCar`, `importSoulchainCar` |

## Chain verification

- `verifyRecords(records, opts)` — walk an array/async iterable (including raw JSON for vectors). Returns `{ valid, head }` or `{ valid: false, failures }` with stable `ChainRule` ids.
- `opts.doorPublicKeys` is a **doorId → public key** map (residency Door portion, e.g. `discord:guild123`). Cosigners verify only against that Door's key.
- PoP: tracks arrival sessions for `bad_session_continuity` and same-epoch multi-door `presence_conflict`.
- Tombstones (records.md rule 12): `target_cid` must be an earlier record on the chain and `blob_cid` its `text_cid`/`journal_cid` (or an already-tombstoned blob); violations are `bad_tombstone`.
- Raw records carrying an own `"__proto__"` key anywhere are a `schema_violation` (and `canonicalize` throws `EncodingError`) — such keys would otherwise be silently dropped, making record bytes malleable.
- Rules are implemented once, in the incremental `ChainVerifier`; `verifyRecords` walks a whole chain with it and every store's `append` evaluates the candidate against the loaded prefix before any durable write.
- `verifyChain(store, opts)` — same rules via `store.iterate()`, then cross-checks `store.head()`. A head mismatch uses rule `forked_head` (message: store head ≠ verified head); duplicate-seq forks also use `forked_head` but originate inside `verifyRecords`.
- After a mid-chain `schema_violation`, later `seq_gap` / `broken_prev_link` entries may appear as cascade noise; check rule presence rather than assuming a minimal `failures` list.
| SoulStore | `SoulStore`, `FileSoulStore`, `IpfsSoulStore`, `DualSoulStore`, `HeadInfo`, `AppendResult`, open-option types |
| Replication | `enqueueReplication`, `ackReplication`, `readReplicationJournal`, `recoverReplicationJournal`, `listPendingReplication`, `listUnackedForTarget`, enqueue/ack types |
| Errors | `SchemaError`, `VerificationError`, `EncodingError`, `StorageError`, `CorruptionError`, `ConcurrentAppendError`, `ChainMismatchError` |

## SoulStore

`FileSoulStore` is the v0.1 append-only local implementation of `SoulStore` (`append`, `head`, `get`, `iterate`). Internally it composes store modules (`BlobDir` for CID-addressed blobs, `FileLock` for exclusive append, and `fsync` helpers for durable writes).

**Layout** (under the soulchain directory):

- `chain.jsonl` — one canonical JSON record per line (no pretty-printing)
- `blobs/<cid>` — raw record bytes keyed by CID
- `.append.lock` — exclusive lock during append (`wx`); metadata `{pid, acquiredAt, nonce}`. Recovery treats a lock with our own PID but a nonce this process does not hold as stale (container PID 1 reused after restart); other PIDs are live while the process exists and the lock is fresh.

**Open:** `FileSoulStore.open(dir)` validates the chain on load and **never** silently truncates torn writes. A partial trailing line (crash mid-append) or other corruption throws `CorruptionError`. Use `FileSoulStore.openWithRecovery(dir)` to remove a stale lock, truncate a torn trailing line, then open; it returns `{ store, truncatedBytes }`.

**Read-only open:** `FileSoulStore.openReadOnly(dir)` requires an existing directory with `chain.jsonl` and `blobs/` (no `mkdir`, no lock). Torn trailing lines and verification failures are reported via `verification()` instead of throwing; intact records remain readable via `head`, `get`, and `iterate`. `append` throws `StorageError` ("read-only").

**Canonical bytes:** only canonical JSON (from `canonicalize`) is written to `chain.jsonl` and blob files; CIDs are computed from those bytes.

**Append verification:** `append` runs the full chain rules (mixed spec, drift evidence, tombstone references, PoP continuity/conflicts, signatures, cosigners) for the candidate against the loaded chain **before** writing anything, so an append can never brick the next open. Structural rule failures throw `ChainMismatchError`; other chain-rule failures throw `VerificationError` (`append rejected: <rule> …`); per-record signature/schema errors keep their original types.

**Blob writes:** temp file → fsync → rename → directory fsync. A pre-existing blob whose bytes do not hash to its CID (torn by a crash) is replaced atomically; an existing identical blob is fsynced before returning.

**Store errors:** `StorageError` (I/O), `CorruptionError` (torn/invalid chain on open; chain verification failures include optional `failures: ChainFailure[]`), `ConcurrentAppendError` (lock held), `ChainMismatchError` (`prev`/`seq` ≠ head on append).

### IpfsSoulStore (v0.2 L1)

Local blockstore-backed store using `blockstore-fs` (no helia, no network). Same `SoulStore` contract and CIDs as `FileSoulStore`.

**Layout:**

- `blocks/` — FsBlockstore sharded block files (opaque canonical record bytes)
- `HEAD` — JSON `{"cid":"bagu…","seq":n}` (atomic tmp + rename + fsync)
- `seq-index.jsonl` — append-only `{"seq":n,"cid":"bagu…"}` journal for ordered `iterate()`
- `LOCK` — exclusive wx lock during append

**Open:** `IpfsSoulStore.open(dir)` validates on load; torn seq-index tails throw `CorruptionError`. `HEAD` must name exactly the last seq-index entry (seq **and** CID). Use `IpfsSoulStore.openWithRecovery(dir)` to clear stale locks, truncate torn `seq-index.jsonl` / `replication.jsonl` tails, and advance a stale `HEAD` when blocks+index are ahead (block-written / HEAD-not-updated crash window) — only after the whole indexed chain verifies, and never when `HEAD` diverges from the index. Returns `{ store, truncatedBytes }` (bytes removed from both journals).

**Read-only:** `IpfsSoulStore.openReadOnly(dir)` requires existing layout; throws on corruption (no soft verification in Phase B).

### DualSoulStore (v0.2 dual-write)

`DualSoulStore.open(fileDir, ipfsDir)` opens both stores. When both are non-empty, differing heads are a fatal `CorruptionError`, as is a populated mirror behind an empty authoritative file store. At open, every blob tombstoned on the chain is removed from the mirror (erasure reconciliation). `append` writes to `FileSoulStore` first (authoritative), then `IpfsSoulStore`; `head`/`get`/`iterate` read from file. If IPFS append fails after file succeeded, the error propagates (dual-write integrity is not auto-repaired).

`DualSoulStore.openWithRecovery(fileDir, ipfsDir)` runs `FileSoulStore.openWithRecovery` and `IpfsSoulStore.openWithRecovery`, asserts compatible heads, and returns `{ store, truncatedBytes }` (sum of both recoveries).

### Replication queue (T7.1d)

`replication.jsonl` under the IPFS soulchain directory is an append-only journal of enqueue lines `{"cid","kind","enqueued_at"}` and per-target ack lines `{"acked","target","at"}`. `enqueueReplication`, `ackReplication`, `readReplicationJournal`, `recoverReplicationJournal`, `listPendingReplication`, and `listUnackedForTarget` implement the queue. Torn trailing lines throw on plain read; `recoverReplicationJournal` truncates like seq-index recovery.

When `IpfsSoulStoreOpenOptions.replication.enabled` is true, successful appends enqueue the record CID after HEAD is durable; enqueue failures never fail append.

### Pin manifest and CAR (T7.1c)

Distribution artifacts for recursive pinning and volunteer CAR imports (`spec/osp/ipfs-store.md` §4).

| API | Purpose |
|-----|---------|
| `buildUnsignedPinManifest`, `signPinManifest`, `verifyPinManifest` | Build, soul-sign, and verify dag-json pin manifests |
| `encodePinManifest` / `decodePinManifest` / `encodeUnsignedPinManifest` | dag-json bytes round-trip (CID links, canonical key order) |
| `computeManifestCid`, `computeManifestCidFromBytes` | Manifest block CID (dag-json codec + sha2-256) |
| `listRecordCidsFromIpfsDir`, `buildAndSignPinManifestForIpfsDir` | Derive a manifest from an on-disk `IpfsSoulStore` via `seq-index.jsonl` |
| `exportSoulchainCar`, `importSoulchainCar` | CARv1 export/import with manifest root; record bytes are opaque (never re-encoded) |

**Manifest:** `osp_pin_manifest: "osp-ipfs/0.1"`, IPLD links for `head`, `genesis`, `records[]`, optional `prev_manifest`, `generated_at`, soul-key `sig` over unsigned dag-json bytes. Not a chain record — regenerable from the store at any time. `decodePinManifest` rejects bytes that do not re-encode byte-identically (unknown keys, non-canonical encoding).

**CAR:** Root is the manifest CID; contains manifest block + every record block in original bytes. Import writes `blocks/`, `seq-index.jsonl`, and `HEAD` so `IpfsSoulStore.openReadOnly` works on the result.

## Test

```bash
pnpm --filter @npc/osp-core test
```

## Generate JSON Schema

Emits `spec/osp/schema/records.json` (and `envelope.json`) from Zod types:

```bash
pnpm --filter @npc/osp-core generate:schema
```

Structural refinements (chain-link nullability, cosigner rules) are documented in `spec/osp/records.md` and enforced at runtime by `RecordSchema`, not in the emitted JSON Schema.
