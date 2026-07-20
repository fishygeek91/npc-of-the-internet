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
| Errors | `SchemaError`, `VerificationError`, `EncodingError` |

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
