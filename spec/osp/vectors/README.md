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
| `expected` | `"valid"` or a `ChainRule` identifier (e.g. `bad_soul_sig`) |
| `soulPublicKey` | Base64url-encoded soul public key (from genesis) |
| `doorPublicKeys` | Door public keys passed to verification |
| `records` | Ordered signed OSP records |

## TEST-ONLY keys

The generator (`packages/osp-core/scripts/generate-vectors.ts`) uses **deterministic TEST-ONLY** Ed25519 private keys (fixed 32-byte fill patterns: soul=7, door=8, session=9, alternate door=10). These keys exist only for conformance fixtures and must never be used in production or live soulchains.
