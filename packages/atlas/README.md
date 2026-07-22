# @npc/atlas

Read-only HTTP API over a soulchain directory. Atlas derives Wanderer presence, chain head, record listings, and residency journals without writing to disk.

## Purpose

The Atlas API serves public chain state for the NPC of the Internet site and operators. It opens the soulchain **read-only** via `FileSoulStore.openReadOnly` from `@npc/osp-core`: no `mkdir`, no `.append.lock`, no truncation. A torn trailing `chain.jsonl` line is skipped on read; `verified: false` is returned instead of failing the request.

## Environment

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ATLAS_CHAIN_DIR` | yes | — | Path to the soulchain directory (`chain.jsonl` + `blobs/`). |
| `ATLAS_PORT` | no | `8787` | TCP port for the HTTP server. |
| `ATLAS_DOOR_PUBKEYS` | no | — | Comma-separated base64url Ed25519 door public keys for cosignature verification. |

Load configuration with `loadAtlasConfig()` or start the binary:

```bash
ATLAS_CHAIN_DIR=./soulchain-data pnpm --filter @npc/atlas start
```

## State derivation (`GET /state`)

Scans **attestation** records from newest to oldest:

| Latest attestation `body.kind` | `status` | `door_id` | `epoch` |
|-------------------------------|----------|-----------|---------|
| `arrival`, `heartbeat` | `present` | `body.door_id` | `body.epoch` |
| `departure` | `traveling` | `null` | `body.epoch` |
| `travel` | `traveling` | `null` | `body.from_epoch` |
| `handover` | `traveling` | `null` | `body.depart_epoch` |
| (none) | `sleeping` | `null` | `null` |

`last_record_at` comes from the **head** record body's type-specific timestamp (`created_at`, `at`, `distilled_at`, etc.).

**Torn-tail policy:** incomplete last line is ignored; intact prefix remains readable; `verified` is `false` when chain verification fails.

## Endpoints

All successful responses include `verified: boolean` where applicable.

### `GET /state`

Wanderer presence snapshot.

### `GET /chain/head`

Current head `{ cid, seq, kind, verified }`. `404 chain_empty` when no records; `503 chain_unreadable` on structural failure.

### `GET /records`

Query: `type` (record type), `page` (default 1), `per_page` (default 50, max 200).

Returns `{ records, page, per_page, total, verified }`. Each record: `{ cid, seq, kind, issued_at, summary }`. Summaries never include shard `text` or `journal`.

`400 invalid_type` for unknown `type`.

### `GET /journals`

Memory shards with `body.journal`, newest first: `{ journals: [{ epoch, door_id, cid, journal }], verified }`.

## Library usage

```typescript
import { createAtlasServer, loadAtlasConfig } from "@npc/atlas";

const config = loadAtlasConfig();
const app = await createAtlasServer(config);
await app.listen({ port: config.port, host: "0.0.0.0" });
```

Tests use `fastify.inject()` against `createAtlasServer` without listening.

## Fixtures

Generate the committed multi-residency test chain:

```bash
pnpm --filter @npc/atlas generate:fixtures
```

Output: `test/fixtures/multi-residency/` plus `fixture-meta.json` (door public keys for tests).

## Test

```bash
pnpm --filter @npc/atlas test
```

Coverage includes read-only guarantees, lock coexistence, state branches, torn-tail handling, reload after append, pagination, journals ordering, and leak safety for shard text.
