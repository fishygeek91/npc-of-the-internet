# OSP chain verification conformance vectors

Committed JSON fixtures for soulchain verification (`verifyRecords` / `verifyChain`). Each file exercises one expected outcome: either a valid mini-chain or a specific `ChainRule` failure.

## Regenerating

Vectors are **not** generated at test time. To rebuild after changing the generator or signing rules:

```bash
pnpm --filter @npc/osp-core generate:vectors
```

Commit the updated JSON under this directory in the same PR as any generator or verification changes.

## File format

Each `*.json` file contains:

| Field | Description |
|-------|-------------|
| `description` | Human-readable case summary |
| `expected` | `"valid"` or a `ChainRule` identifier: `bad_soul_sig`, `broken_prev_link`, `seq_gap`, `schema_violation`, `missing_cosigner`, `forked_head`, `bad_genesis`, `bad_drift_evidence`, `bad_tombstone` (records.md rule 12), `bad_session_continuity`, `presence_conflict` |
| `soulPublicKey` | Base64url-encoded soul public key (from genesis) |
| `doorPublicKeys` | Door public keys keyed by residency Door id (e.g. `"discord:g": "<base64url>"`) passed to verification |
| `records` | Ordered signed OSP records |
| `blobs` | Optional. Map of side-blob bytes for `osp/0.2` vectors: `{ "<cid>": "<base64url-bytes>", … }`. Keys are side-blob CIDs; values are base64url-encoded opaque blob bytes. **`verifyChain` does not require blobs to be present** — chain verification binds to CID + hash references. When supplied, verifiers MAY optionally check `sha256(blobBytes)` against the corresponding `text_hash` / `journal_hash`. |

## TEST-ONLY keys

The generator (`packages/osp-core/scripts/generate-vectors.ts`) uses **deterministic TEST-ONLY** Ed25519 private keys (fixed 32-byte fill patterns: soul=7, door=8, session=9, alternate door=10). These keys exist only for conformance fixtures and must never be used in production or live soulchains.

## Strict RFC 8032 vector

`bad-soul-sig-small-order-key.json` uses the small-order identity point as the soul public key and `R = identity, S = 0` as every soul signature. That pair satisfies the cofactored ZIP-215 equation for any message, so a ZIP-215 verifier would accept the chain; strict RFC 8032 verification (records.md, "Signature encoding") rejects the key and each record fails `bad_soul_sig`. The generator asserts both properties when it builds the vector.

## Pin manifests

Pin manifests (`ipfs-store.md` §4) have no conformance-vector format; canonical-decode rules (non-canonical bytes, unknown keys, whitespace) are covered by unit tests in `packages/osp-core/test/pin-manifest.test.ts`.
