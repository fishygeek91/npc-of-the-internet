# @npc/atlas

Read-only HTTP API over a soulchain directory. Atlas derives Wanderer presence, chain head, record listings, and residency journals without writing to disk.

## Purpose

The Atlas API serves public chain state for the NPC of the Internet site and operators. It opens the soulchain **read-only** via `FileSoulStore.openReadOnly` from `@npc/osp-core`: no `mkdir`, no `.append.lock`, no truncation. A torn trailing `chain.jsonl` line is skipped on read; `verified: false` is returned instead of failing the request.

`AtlasError.code` is the closed set `ATLAS_ERROR_CODES`: `invalid_request`, `invalid_type`, `chain_empty`, `car_not_found`, `manifest_not_found`, `export_after_unknown`, `invalid_config`, `internal_error`, `chain_unreadable`.

## Environment

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ATLAS_CHAIN_DIR` | yes | — | Path to the soulchain directory (`chain.jsonl` + `blobs/`). |
| `ATLAS_PORT` | no | `8787` | TCP port for the HTTP server. |
| `ATLAS_DOOR_PUBKEYS` | no | — | Comma-separated `doorId=base64url` Ed25519 door public key bindings for cosignature verification. |

Load configuration with `loadAtlasConfig()` or start the binary:

```bash
ATLAS_CHAIN_DIR=./soulchain-data pnpm --filter @npc/atlas start
```

## State derivation (`GET /state`)

Scans newest to oldest. A `sleep` record encountered before any attestation yields `sleeping` (do not fake presence). Otherwise the latest attestation maps as:

| Record | `status` | `door_id` | `epoch` | `since` |
|--------|----------|-----------|---------|---------|
| `type: sleep` | `sleeping` | `null` | `null` | `body.as_of` |
| attestation `arrival` / `heartbeat` | `present` | `body.door_id` | `body.epoch` | start of the uninterrupted stay at that Door (see below) |
| attestation `departure` | `traveling` | `null` | `body.epoch` | `body.at` |
| attestation `travel` | `traveling` | `null` | `body.from_epoch` | `body.at` |
| attestation `handover` | `traveling` | `null` | `body.depart_epoch` | `body.at` |
| (none) | `sleeping` | `null` | `null` | `null` |

The Wanderer is at one Door at a time: `present` names that Door and when it arrived; `traveling` means it has left (see `GET /residencies` for where it went).

A Door restart supersedes the open residency without a departure, and the Wanderer re-arrives at the same Door in a new epoch. That is a restart, not a move: `since` is the `at` of the earliest arrival in the run of consecutive same-Door arrivals with no departure, travel, handover or sleep between them.

`last_record_at` comes from the **head** record body's type-specific timestamp (`created_at`, `at`, `distilled_at`, etc.).

**Torn-tail policy:** incomplete last line is ignored; intact prefix remains readable; `verified` is `false` when chain verification fails.

**CORS:** `@fastify/cors` with `origin: true`, `methods: ["GET"]`, and `ETag` exposed (`Access-Control-Expose-Headers`) so a page on another origin can send `If-None-Match` (for door-web and replica shrines).

**Unreadable chain:** `503` with `{ error: { code: "chain_unreadable", message: "chain is unreadable" } }`. Detail (including filesystem paths) is logged server-side only. Unreadable snapshots are not cached, so repairing `blobs/` recovers on the next request without an append/restart.

## Endpoints

All successful responses include `verified: boolean` where applicable.

### `GET /state`

Wanderer presence snapshot.

### `GET /chain/export`

Full chain for in-browser verification (`spec/door/web.md`). Not a summary.

Returns `{ records, doorPublicKeys, blobs }`. `records` are the full signed bodies in chain order, so an `osp/0.1` shard's inline `text` is included (`GET /records` serves summaries instead). `doorPublicKeys` is door id → base64url **public** key (the `ATLAS_DOOR_PUBKEYS` set; private keys are not a field). `blobs` is journal side-blob CID → base64url bytes; shard `text_cid` blobs are omitted, and so is any CID named by a tombstone `blob_cid` anywhere on the chain. Missing CIDs are unavailable, not erased. There is no `verified` field.

`?after=<cid>` returns the same shape for the records strictly after that CID (the cursor itself is not included) and the journal blobs those records reference. `after` must be a bagu CID (`CidSchema`). Anything else is `400` `invalid_request`. A CID that is not a record on the chain is `404` `export_after_unknown` (`EXPORT_AFTER_UNKNOWN_CODE`); the client drops its chain and fetches the full export once. `after` equal to the head is `200` with `records: []` and `blobs: {}`. A tombstone in the tail still carries `body.blob_cid`, which is the blob the client drops. The bytes stay out of `blobs`. See `spec/door/web.md`.

`200` includes `ETag` and `Cache-Control: no-cache`. A tail's `ETag` is not the full export's tag and differs for each `after` value. `If-None-Match` of that tag (or `*`, or the same tag as a weak validator) returns `304` with an empty body. A tag from a different `after`, or from the full export, does not. `503 chain_unreadable` uses the same error object as the other routes.

### `GET /chain/head`

Current head `{ cid, seq, kind, verified }`. `404 chain_empty` when no records; `503 chain_unreadable` on structural failure.

### `GET /records`

Query: `type` (record type), `page` (default 1), `per_page` (default 50, max 200).

Returns `{ records, page, per_page, total, verified }`. Each record: `{ cid, seq, kind, issued_at, summary }`. Summaries never include shard `text` or `journal`; `rejected` summaries carry only the category (`memory/rejected category=witness_private`), travel summaries the destination (`to=web:home`).

`400 invalid_type` for unknown `type`.

### `GET /journals`

Residency journals, newest first: witnessed `journal` records (one per residency, `osp/0.2`) plus legacy journals embedded on shards (inline `journal` or `journal_cid`). A tombstoned or missing journal blob shows `[journal erased]`.

Query: `page` (default 1), `per_page` (default 50, max 200).

Returns `{ journals: [{ epoch, door_id, cid, journal }], page, per_page, total, verified }` (`cid` is the record carrying the journal).

### `GET /residencies`

One entry per residency (Door + epoch), newest first. Same pagination as `/journals`.

Returns `{ residencies, page, per_page, total, verified }`. Each residency:

| Field | Meaning |
|-------|---------|
| `residency`, `door_id`, `epoch` | The residency string and its parts |
| `arrived_at` / `departed_at` | Arrival `at`; departure `at` (else travel / handover `at`, else the `at` of the next arrival that superseded it), or `null` |
| `ended` | `departed` (departure / travel / handover record), `superseded` (a later arrival closed it with no such record, e.g. a Door restart), or `null` while open |
| `traveled_to` | Door named by the travel (`to_door_id`) or handover record that ended it, or `null` |
| `counts.witnessed` | Shards the Door's witness co-signed |
| `counts.declined` | `rejected` records with a `witness_<reason>` category |
| `counts.screened` | Other `rejected` records (the Wanderer's own immune screen, e.g. `pii.email`) |
| `declined_reasons` | Distinct witness reasons in chain order (e.g. `["private"]`) |
| `journal` | `{ cid, journal }` for the residency's journal, or `null` |

Legacy `candidate` records are counted in none of the buckets.

## Library usage

```typescript
import { createAtlasServer, loadAtlasConfig, registerShutdownSignals } from "@npc/atlas";

const config = loadAtlasConfig();
const app = await createAtlasServer(config);
registerShutdownSignals(app); // SIGTERM/SIGINT → app.close() → exit (container PID 1)
await app.listen({ port: config.port, host: "0.0.0.0" });
```

`ChainView` (used by the server) reloads only when `chain.jsonl` size/mtime changes; concurrent
requests share one in-flight load, and an unreadable result is reused for at most
`unreadableTtlMs` (default 2 s) while neither `chain.jsonl` nor the `blobs/` directory changes.

Tests use `fastify.inject()` against `createAtlasServer` without listening.

## Fixtures

Generate the committed multi-residency test chain:

```bash
pnpm --filter @npc/atlas generate:fixtures
```

Output: `test/fixtures/multi-residency/` (an `osp/0.2` chain with side blobs) plus `fixture-meta.json` (door public keys for tests). Three residencies: `discord:g` (legacy candidate + shard-embedded journal), `irc:libera-wanderer` (legacy shard-embedded journal) and `web:home` (witnessed shard, `witness_private` decline, `pii.email` screen drop, `journal` record), each ending in a departure and travel to the next Door. The chain ends traveling.

## Test

```bash
pnpm --filter @npc/atlas test
```

Coverage includes read-only guarantees, lock coexistence, state branches, torn-tail handling, reload after append, pagination, journals ordering (journal records and legacy shard journals), residency counts and travel, erased journal markers, leak safety for shard text, and `GET /chain/export` (public keys only, journal blobs, tail `after`, `ETag`).
