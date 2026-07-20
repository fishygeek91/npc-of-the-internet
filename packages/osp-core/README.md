# @npc/osp-core

OSP soulchain primitives: Zod record schemas, canonical JSON, Ed25519 signing, CID computation, and record create/verify helpers. Normative prose lives in `spec/osp/records.md`.

## Public API

| Area | Exports |
|------|---------|
| Schemas | `RecordSchema`, body schemas (`GenesisBodySchema`, …), `OspRecord` types |
| Canonical JSON | `canonicalize` — sorted keys, no whitespace (UTF-16 code-unit order) |
| Encoding | `encodeBase64Url`, `decodeBase64Url`, `encodePublicKey`, `decodePublicKey`, `encodeSignature`, `decodeSignature` |
| Ed25519 | `generateKeypair`, `sign`, `verify` |
| CIDs | `computeCid`, `computeCidFromCanonicalBytes` — dag-json codec + sha2-256 → CIDv1 base32 strings (typically `bagu…`, not `bafy…` which is dag-pb) |
| Records | `createRecord`, `verifyRecord`, `signCore`, `corePayload`, `soulPayload` |
| SoulStore | `SoulStore`, `FileSoulStore`, `HeadInfo`, `AppendResult`, `FileSoulStoreOpenOptions` |
| Errors | `SchemaError`, `VerificationError`, `EncodingError`, `StorageError`, `CorruptionError`, `ConcurrentAppendError`, `ChainMismatchError` |

## SoulStore

`FileSoulStore` is the v0.1 append-only local implementation of `SoulStore` (`append`, `head`, `get`, `iterate`).

**Layout** (under the soulchain directory):

- `chain.jsonl` — one canonical JSON record per line (no pretty-printing)
- `blobs/<cid>` — raw record bytes keyed by CID
- `.append.lock` — exclusive lock during append (`wx`)

**Open:** `FileSoulStore.open(dir)` validates the chain on load and **never** silently truncates torn writes. A partial trailing line (crash mid-append) or other corruption throws `CorruptionError`. Use `FileSoulStore.openWithRecovery(dir)` to remove a stale lock, truncate a torn trailing line, then open; it returns `{ store, truncatedBytes }`.

**Canonical bytes:** only canonical JSON (from `canonicalize`) is written to `chain.jsonl` and blob files; CIDs are computed from those bytes.

**Store errors:** `StorageError` (I/O), `CorruptionError` (torn/invalid chain on open), `ConcurrentAppendError` (lock held), `ChainMismatchError` (`prev`/`seq` ≠ head on append).

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
