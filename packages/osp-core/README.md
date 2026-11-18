# @npc/osp-core

OSP soulchain primitives: Zod record schemas, canonical JSON, Ed25519 signing, CID computation, and record create/verify helpers. Normative prose lives in `spec/osp/records.md`.

## Public API

| Area | Exports |
|------|---------|
| Schemas | `RecordSchema`, body schemas (`GenesisBodySchema`, …), `OspRecord` types, `RECORD_TYPES`, `RecordType`, `RESIDENCY_RE`, `parseResidency`, `isResidency`, `asResidency`, `makeResidency` |
| Canonical JSON | `canonicalize` — sorted keys, no whitespace (UTF-16 code-unit order) |
| Encoding | `encodeBase64Url`, `decodeBase64Url`, `asBase64Url`, `isBase64Url`, `encodePublicKey`, `decodePublicKey`, `asSoulPublicKey`, `isSoulPublicKey`, `SoulPublicKeySchema`, `encodeSignature`, `decodeSignature`, `asEd25519Signature`, `isEd25519Signature`, `Ed25519SignatureSchema`, `parsePrivateKeyBytes` |
| Ed25519 | `generateKeypair`, `publicKeyFromPrivate`, `sign`, `verify` (raw `Uint8Array` keys and signatures) |
| CIDs | `computeCid`, `computeCidFromCanonicalBytes`, `asCid`, `parseCid`, `isValidCid` — dag-json codec + sha2-256 → CIDv1 base32 strings (typically `bagu…`, not `bafy…` which is dag-pb) |
| Brands | `Cid`, `SoulPublicKey`, `Ed25519Signature`, `Base64Url`, `Residency` — see below |
| Records | `createRecord`, `createRecordWithSigner`, `verifyRecord`, `signCore`, `corePayload`, `soulPayload` |
| Shard text | `SHARD_TEXT_MAX_CODE_POINTS` (500), `countCodePoints` — one length for schema and side-blob encoding |
| Door keys | `parseDoorPublicKeyBinding`, `parseDoorPublicKeyMap`, `hasDoorPublicKeys` — `doorId=base64url` bindings |
| Chain verify | `verifyRecords`, `verifyChain`, `ChainRule`, `ChainFailure`, `VerifyChainResult`, `VerifyChainOptions` |
| Pin manifest | `buildUnsignedPinManifest`, `signPinManifest`, `verifyPinManifest`, `encodePinManifest`, `decodePinManifest`, `computeManifestCid`, `listRecordCidsFromIpfsDir`, `buildAndSignPinManifestForIpfsDir` |
| CAR | `exportSoulchainCar`, `importSoulchainCar` |
| Browser | `@npc/osp-core/browser` — see below. Not re-exported from the package root. |

`createRecord` signs with a soul private key. `createRecordWithSigner(fields, signSoul)` is the same sealer with a synchronous soul signer (`(bytes: Uint8Array) => Uint8Array`). Both default `spec` to `OSP_SPEC` (`osp/0.1`).

`RECORD_TYPES` is every envelope `type` (including `tombstone`), in schema order. `RecordType` is that union (`OspRecord["type"]`).

`parsePrivateKeyBytes` reads private-key file bytes: exactly 32 raw bytes, otherwise trimmed UTF-8 that is unpadded base64url for 32 bytes. It throws `PrivateKeyParseError` (an `EncodingError`) and does not take a path or include key bytes. `publicKeyFromPrivate` is the Ed25519 public-key derivation callers should use.

### Branded wire strings

`Cid`, `SoulPublicKey`, `Ed25519Signature`, `Base64Url`, and `Residency` are Zod output brands (`schema.brand<"Name">()`, direction `"out"`). The brand is erased at runtime: record bytes, base64url text, and `spec/osp/schema/*.json` stay the same. A plain `string` is not assignable to a brand. A brand is assignable to `string`.

Crypto functions keep raw bytes. `sign`, `verify`, `decodePublicKey`, `decodeSignature`, `VerifyRecordOptions.soulPublicKey`, and door-key maps take `Uint8Array`. `encodePublicKey`, `encodeSignature`, and `encodeBase64Url` are the crossings back to wire brands. `SoulPublicKey` is every 32-byte Ed25519 wire key (soul, session, and Door) — it stops those strings being passed where a CID or signature is required, and it does not distinguish key roles.

| Brand | Produced by | Checked by |
|-------|-------------|------------|
| `Cid` | `computeCid`, `computeCidFromCanonicalBytes`, `CidSchema` parse | `asCid`, `parseCid`, `isValidCid` |
| `SoulPublicKey` | `encodePublicKey`, `SoulPublicKeySchema` parse | `asSoulPublicKey`, `isSoulPublicKey`, `decodePublicKey` |
| `Ed25519Signature` | `encodeSignature`, `signCore`, `Ed25519SignatureSchema` parse | `asEd25519Signature`, `isEd25519Signature`, `decodeSignature` |
| `Base64Url` | `encodeBase64Url` (empty string encodes zero bytes) | `asBase64Url`, `isBase64Url` (`decodeBase64Url` also rejects empty input) |
| `Residency` | `makeResidency({ doorId, epoch })` | `asResidency`, `isResidency`, `parseResidency` |

`makeResidency({ doorId, epoch })` takes the `platform:id` door id `parseResidency` returns (`discord:guild123`) and builds `door:<doorId>/epoch:<n>`. `makeResidency(parseResidency(value))` round-trips. `OspRecord.residency` stays `string | null` because genesis and tombstones require null; brand it with `asResidency` when the value is non-null.

Parsed record CID fields, `soul_pubkey` / `session_pubkey`, `sig`, and `cosigners` are branded outputs. `CreateRecordFields` (and `SoulStore.get`, `expectedCid`, replication journal entries) still accept plain `string`, so a brand or an unbranded string can be passed in. `HeadInfo.cid`, `AppendResult.cid`, and `PutSideBlobResult.cid` are `Cid`. `createRecord` / `verifyRecord` return `cid: Cid`.

## Browser verification

Import `@npc/osp-core/browser` from a porch page or replica shrine. Do not bundle the package root: that entry loads `SoulStore` (`node:fs` and the other Node stores). The browser subpath exports `ChainVerifier`, `ChainStep`, `verifyRecords`, `verifyRecord`, `verify`, `canonicalize`, `computeCid`, `decodePublicKey`, `decodeSignature`, `parseResidency`, `hashBlobBytes`, `cidMatchesHash`, and `decodeJournalBlob`.

`verify` is strict RFC 8032 via `@noble/ed25519`. CID hashing uses `multiformats` sha2-256; a browser bundle resolves the `browser` export (`crypto.subtle`), not `node:crypto`. The contract for PRESENT / ELSEWHERE, session-key checks, and the shrine embed is `spec/door/web.md`.

```typescript
import { ChainVerifier, verifyRecords, decodePublicKey } from "@npc/osp-core/browser";
```

Keep one `ChainVerifier` per page. `evaluate` returns a step; call `commit` on that step to admit the record. Callers collect each `step.failures` themselves — `ChainVerifier` has no result method. An empty list with `verifier.head` is `{ valid: true, head }`; a non-empty list is `{ valid: false, failures }`. Feeding a prefix and then the tail that way yields the same result as `verifyRecords` on the full chain. `verifyChain` stays on the package root because it needs a `SoulStore`.

Key generation, `sign`, `createRecord`, pin manifests, and CAR stay on the package root.

## Chain verification

- `verifyRecords(records, opts)` — walk an array/async iterable (including raw JSON for vectors). Returns `{ valid, head }` or `{ valid: false, failures }` with stable `ChainRule` ids.
- `opts.doorPublicKeys` is a **doorId → public key** map (residency Door portion, e.g. `discord:guild123`). Cosigners verify only against that Door's key.
- PoP: tracks arrival sessions for `bad_session_continuity` and same-epoch multi-door `presence_conflict`.
- Tombstones (records.md rule 12): `target_cid` must be an earlier record on the chain and `blob_cid` its `text_cid`/`journal_cid` (or an already-tombstoned blob); violations are `bad_tombstone`.
- Raw records carrying an own `"__proto__"` key anywhere are a `schema_violation` (and `canonicalize` throws `EncodingError`) — such keys would otherwise be silently dropped, making record bytes malleable.
- Rules are implemented once, in the incremental `ChainVerifier` (exported from `@npc/osp-core/browser` with `ChainStep`); `verifyRecords` walks a whole chain with it and every store's `append` evaluates the candidate against the loaded prefix before any durable write.
- `verifyChain(store, opts)` — same rules via `store.iterate()`, then cross-checks `store.head()`. A head mismatch uses rule `forked_head` (message: store head ≠ verified head); duplicate-seq forks also use `forked_head` but originate inside `verifyRecords`.
- After a mid-chain `schema_violation`, later `seq_gap` / `broken_prev_link` entries may appear as cascade noise; check rule presence rather than assuming a minimal `failures` list.
| SoulStore | `SoulStore`, `FileSoulStore`, `IpfsSoulStore`, `DualSoulStore`, `HeadInfo`, `AppendResult`, open-option types |
| Replication | `enqueueReplication`, `ackReplication`, `readReplicationJournal`, `recoverReplicationJournal`, `listPendingReplication`, `listUnackedForTarget`, enqueue/ack types |
| Errors | `SchemaError`, `VerificationError` (`reason`: `VERIFICATION_REASONS`), `EncodingError`, `PrivateKeyParseError`, `StorageError`, `CorruptionError`, `ConcurrentAppendError`, `ChainMismatchError` |

## SoulStore

`FileSoulStore` is the v0.1 append-only local implementation of `SoulStore` (`append`, `head`, `get`, `iterate`). Internally it composes store modules (`BlobDir` for CID-addressed blobs, `FileLock` for exclusive append, and `fsync` helpers for durable writes).

**Layout** (under the soulchain directory):

- `chain.jsonl` — one canonical JSON record per line (no pretty-printing)
- `blobs/<cid>` — raw record bytes keyed by CID. Orphaned `.tmp-*` atomic-write files older than an hour are removed on writable open (`open` / `openWithRecovery`).
- `.append.lock` — exclusive lock during append (`wx`); metadata `{pid, acquiredAt, nonce, host, startedAt}` (`startedAt` = process start time). Recovery, while the lock is fresh (< 1 h): another `host` → live (another container's PID namespace cannot be probed); same host, other PID → live while that process exists; same host and PID → live when `startedAt` matches ours within 1 s (a worker thread or second module instance of this process), stale otherwise (previous incarnation reusing the PID, e.g. container PID 1). Legacy locks without `host`/`startedAt` (v0.4.3) and our PID are stale unless their nonce is held by this module instance.

**Open:** `FileSoulStore.open(dir)` validates the chain on load and **never** silently truncates torn writes. A partial trailing line (crash mid-append) or other corruption throws `CorruptionError`. Use `FileSoulStore.openWithRecovery(dir)` to remove a stale lock, truncate a torn trailing line, then open; it returns `{ store, truncatedBytes }`.

**Read-only open:** `FileSoulStore.openReadOnly(dir)` requires an existing directory with `chain.jsonl` and `blobs/` (no `mkdir`, no lock). Torn trailing lines and verification failures are reported via `verification()` instead of throwing; intact records remain readable via `head`, `get`, and `iterate`. `append` throws `StorageError` ("read-only").

**Canonical bytes:** only canonical JSON (from `canonicalize`) is written to `chain.jsonl` and blob files; CIDs are computed from those bytes.

**Append verification:** `append` runs the full chain rules (mixed spec, drift evidence, tombstone references, PoP continuity/conflicts, signatures, cosigners) for the candidate against the loaded chain **before** writing anything, so an append can never brick the next open. Structural rule failures throw `ChainMismatchError`; other chain-rule failures throw `VerificationError` with `reason: "append_rejected"` (`append rejected: <rule> …`); per-record signature/schema errors keep their original types.

`VerificationError.reason` is `soul_sig`, `cosigner`, `missing_door_keys`, `cid_mismatch`, `pin_manifest_sig`, or `append_rejected`. Chain verification maps `soul_sig` to `bad_soul_sig` and `cosigner` / `missing_door_keys` to `missing_cosigner`. It rethrows `cid_mismatch` (that check compares a caller-supplied CID; it is not a chain rule). The human-readable `message` is unchanged and is what failure text copies.

**Blob writes:** temp file → fsync → rename → directory fsync. A pre-existing blob whose bytes do not hash to its CID (torn by a crash) is replaced atomically; an existing identical blob is fsynced before returning.

**Store errors:** `StorageError` (I/O), `CorruptionError` (torn/invalid chain on open; chain verification failures include optional `failures: ChainFailure[]`), `ConcurrentAppendError` (lock held), `ChainMismatchError` (`prev`/`seq` ≠ head on append).

### IpfsSoulStore (v0.2 L1)

Local blockstore-backed store using `blockstore-fs` (no helia, no network). Same `SoulStore` contract and CIDs as `FileSoulStore`.

**Layout:**

- `blocks/` — FsBlockstore sharded block files (opaque canonical record bytes)
- `HEAD` — JSON `{"cid":"bagu…","seq":n}` (atomic tmp + rename + fsync)
- `seq-index.jsonl` — append-only `{"seq":n,"cid":"bagu…"}` journal for ordered `iterate()`
- `LOCK` — exclusive wx lock during append (same `FileLock` metadata and recovery rules as `.append.lock`)
- Orphaned block temp files (`.tmp-*`, blockstore-fs `.<name>.tmp`) older than an hour are removed from `blocks/` on writable open

**Open:** `IpfsSoulStore.open(dir)` validates on load; torn seq-index tails throw `CorruptionError`. `HEAD` must name exactly the last seq-index entry (seq **and** CID). Use `IpfsSoulStore.openWithRecovery(dir)` to clear stale locks, truncate torn `seq-index.jsonl` / `replication.jsonl` tails, and advance a stale `HEAD` when blocks+index are ahead (block-written / HEAD-not-updated crash window) — only after the whole indexed chain verifies, and never when `HEAD` diverges from the index. Returns `{ store, truncatedBytes }` (bytes removed from both journals).

**Read-only:** `IpfsSoulStore.openReadOnly(dir)` requires existing layout; throws on corruption (no soft verification in Phase B).

### DualSoulStore (v0.2 dual-write)

`DualSoulStore.open(fileDir, ipfsDir)` opens both stores. When both are non-empty, differing heads are a fatal `CorruptionError`, as is a populated mirror behind an empty authoritative file store. At open, every blob tombstoned on the chain that the file store no longer holds is removed from the mirror (erasure reconciliation; the mirror follows the file store, so a blob re-put by a later live record is kept). `append` writes to `FileSoulStore` first (authoritative), then `IpfsSoulStore`; `head`/`get`/`iterate` read from file. If IPFS append fails after file succeeded, the error propagates (dual-write integrity is not auto-repaired).

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
