# PoP conformance vectors

Committed JSON fixtures for Proof-of-Presence (`pop/0.1`) cryptography. When this prose and an implementation disagree, **these vectors are the final arbiter** (see `spec/pop/overview.md` §4.1).

## Regenerating

Vectors are **not** generated at test time. To rebuild after changing the derivation algorithm or generator:

```bash
pnpm --filter "./packages/runtime" generate:pop-vectors
```

Commit updated JSON under this directory in the same PR as any derivation or generator changes.

## Session-key derivation (`session-key-derivation.json`)

### Algorithm (normative)

Given:

- **IKM** — 32-byte soul private key (Ed25519 seed material)
- **salt** — UTF-8 bytes of the literal string `npc-pop/0.1/session-key`
- **info** — `UTF-8(door_id) || 0x00 || ASCII decimal(epoch)` where `door_id` is the platform-scoped identifier (`platform:community-id`, e.g. `discord:guild123`) with **no** `door:` prefix, and `epoch` is a positive integer encoded in decimal with no leading zeros
- **OKM length** — 32 bytes

Compute:

1. `session_seed = HKDF-SHA-512(ikm=IKM, salt=salt, info=info, length=32)`
2. `session_public_key = Ed25519_public_key(session_seed)` using `@noble/ed25519` with SHA-512 wired via `sha512Sync` (same as `packages/osp-core` and runtime test helpers)

Session signatures in vectors use the derived `session_seed` as the Ed25519 private key over the UTF-8 bytes of `samplePayload`.

### File format

| Field | Description |
|-------|-------------|
| `description` | Human-readable suite summary |
| `algorithm` | Short algorithm identifier string |
| `cases` | Array of derivation test cases |

Each case in `cases`:

| Field | Description |
|-------|-------------|
| `description` | Human-readable case summary |
| `soulPrivateKeyFillByte` | TEST-ONLY: 32-byte soul key filled with this byte |
| `doorId` | Door identifier string (`platform:community-id`) passed into HKDF `info` |
| `epoch` | Positive integer epoch (≥ 1) passed into HKDF `info` |
| `expectedSessionPublicKey` | Base64url-encoded derived session public key |
| `samplePayload` | UTF-8 string signed with the derived session private key |
| `expectedSignature` | Base64url-encoded Ed25519 signature over UTF-8(`samplePayload`) |

## TEST-ONLY keys

The generator (`packages/runtime/scripts/generate-pop-vectors.ts`) uses **deterministic TEST-ONLY** soul private keys (fixed 32-byte fill patterns). These keys exist only for conformance fixtures and must never be used in production or live soulchains.
