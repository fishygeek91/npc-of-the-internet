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
- `verifyChain(store, opts)` — same rules via `store.iterate()`, then cross-checks `store.head()`. A head mismatch uses rule `forked_head` (message: store head ≠ verified head); duplicate-seq forks also use `forked_head` but originate inside `verifyRecords`.
- After a mid-chain `schema_violation`, later `seq_gap` / `broken_prev_link` entries may appear as cascade noise; check rule presence rather than assuming a minimal `failures` list.
| SoulStore | `SoulStore`, `FileSoulStore`, `IpfsSoulStore`, `DualSoulStore`, `HeadInfo`, `AppendResult`, open-option types |
| Errors | `SchemaError`, `VerificationError`, `EncodingError`, `StorageError`, `CorruptionError`, `ConcurrentAppendError`, `ChainMismatchError` |

## SoulStore

`FileSoulStore` is the v0.1 append-only local implementation of `SoulStore` (`append`, `head`, `get`, `iterate`). Internally it composes store modules (`BlobDir` for CID-addressed blobs, `FileLock` for exclusive append, and `fsync` helpers for durable writes).

**Layout** (under the soulchain directory):

- `chain.jsonl` — one canonical JSON record per line (no pretty-printing)
- `blobs/<cid>` — raw record bytes keyed by CID
- `.append.lock` — exclusive lock during append (`wx`)

**Open:** `FileSoulStore.open(dir)` validates the chain on load and **never** silently truncates torn writes. A partial trailing line (crash mid-append) or other corruption throws `CorruptionError`. Use `FileSoulStore.openWithRecovery(dir)` to remove a stale lock, truncate a torn trailing line, then open; it returns `{ store, truncatedBytes }`.

**Read-only open:** `FileSoulStore.openReadOnly(dir)` requires an existing directory with `chain.jsonl` and `blobs/` (no `mkdir`, no lock). Torn trailing lines and verification failures are reported via `verification()` instead of throwing; intact records remain readable via `head`, `get`, and `iterate`. `append` throws `StorageError` ("read-only").

**Canonical bytes:** only canonical JSON (from `canonicalize`) is written to `chain.jsonl` and blob files; CIDs are computed from those bytes.

**Store errors:** `StorageError` (I/O), `CorruptionError` (torn/invalid chain on open; chain verification failures include optional `failures: ChainFailure[]`), `ConcurrentAppendError` (lock held), `ChainMismatchError` (`prev`/`seq` ≠ head on append).

### IpfsSoulStore (v0.2 L1)

Local blockstore-backed store using `blockstore-fs` (no helia, no network). Same `SoulStore` contract and CIDs as `FileSoulStore`.

**Layout:**

- `blocks/` — FsBlockstore sharded block files (opaque canonical record bytes)
- `HEAD` — JSON `{"cid":"bagu…","seq":n}` (atomic tmp + rename + fsync)
- `seq-index.jsonl` — append-only `{"seq":n,"cid":"bagu…"}` journal for ordered `iterate()`
- `LOCK` — exclusive wx lock during append

**Open:** `IpfsSoulStore.open(dir)` validates on load; torn seq-index tails throw `CorruptionError`. Use `IpfsSoulStore.openWithRecovery(dir)` to clear stale locks, truncate torn index lines, and advance a stale `HEAD` when blocks+index are ahead (block-written / HEAD-not-updated crash window). Returns `{ store, truncatedBytes }`.

**Read-only:** `IpfsSoulStore.openReadOnly(dir)` requires existing layout; throws on corruption (no soft verification in Phase B).

### DualSoulStore (v0.2 dual-write)

`DualSoulStore.open(fileDir, ipfsDir)` opens both stores. When both are non-empty, differing heads are a fatal `CorruptionError`. `append` writes to `FileSoulStore` first (authoritative), then `IpfsSoulStore`; `head`/`get`/`iterate` read from file. If IPFS append fails after file succeeded, the error propagates (dual-write integrity is not auto-repaired).

### Pin manifest and CAR (T7.1c)

Distribution artifacts for recursive pinning and volunteer CAR imports (`spec/osp/ipfs-store.md` §4).

| API | Purpose |
|-----|---------|
| `buildUnsignedPinManifest`, `signPinManifest`, `verifyPinManifest` | Build, soul-sign, and verify dag-json pin manifests |
| `encodePinManifest` / `decodePinManifest` / `encodeUnsignedPinManifest` | dag-json bytes round-trip (CID links, canonical key order) |
| `computeManifestCid`, `computeManifestCidFromBytes` | Manifest block CID (dag-json codec + sha2-256) |
| `listRecordCidsFromIpfsDir`, `buildAndSignPinManifestForIpfsDir` | Derive a manifest from an on-disk `IpfsSoulStore` via `seq-index.jsonl` |
| `exportSoulchainCar`, `importSoulchainCar` | CARv1 export/import with manifest root; record bytes are opaque (never re-encoded) |

**Manifest:** `osp_pin_manifest: "osp-ipfs/0.1"`, IPLD links for `head`, `genesis`, `records[]`, optional `prev_manifest`, `generated_at`, soul-key `sig` over unsigned dag-json bytes. Not a chain record — regenerable from the store at any time.

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
