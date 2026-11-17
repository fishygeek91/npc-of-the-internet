# Web verification and replica shrines

**Spec version:** `door/0.2` web contract (does not change the Door wire)  
**License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)

Visitors check for themselves that the Wanderer's words were signed by the Wanderer. Two surfaces share one verification library:

1. **Porch** — the web Door's public room verifies each Wanderer line in the browser.
2. **Replica shrine** — a read-only embed any site may include. It shows a prominent **PRESENT** or **ELSEWHERE** badge and verified journals.

This document is the contract. Record bytes, signatures, and chain rules are defined in [`spec/osp/records.md`](../osp/records.md) and [`spec/pop/overview.md`](../pop/overview.md). Door frame signing is defined in [`spec/door/api.md`](api.md). v0.1 uses the single session key published on the arrival attestation. Session-key rotation and the handover ceremony are PoP v0.2 (T7.3) and are out of scope.

---

## Browser verify entry

Browsers MUST verify soulchain records through the `@npc/osp-core/browser` entry, not the package root. The package root loads `SoulStore`, which uses Node built-ins (`node:fs` and the rest). The browser entry MUST NOT load Node built-ins (`node:fs`, `node:path`, `node:crypto`, `node:buffer`, `node:process`, or any other `node:` module), including transitively.

The entry exposes the same rules as the Node verifier:

| Export | Role |
|--------|------|
| `verifyRecords` | Walk an ordered record array. Same `ChainRule` results as `spec/osp/records.md` Verification. |
| `verifyRecord` | One record: schema, Door cosignatures over `core`, soul signature, optional CID. |
| `canonicalize` | Canonical JSON bytes (sorted keys, no insignificant whitespace). |
| `computeCid` | dag-json + sha2-256 CIDv1 (`bagu…`) via `multiformats`. |
| `verify` | Ed25519, strict RFC 8032 (`zip215: false`), via `@noble/ed25519`. |
| `decodePublicKey` / `decodeSignature` | Base64url (no padding) to raw bytes. |
| `parseResidency` | `door:<door-id>/epoch:<n>` → door id + epoch. |
| `hashBlobBytes` / `cidMatchesHash` / `decodeJournalBlob` | Optional side-blob checks. Missing blob bytes do not fail chain verification. |

Cryptography is `@noble/ed25519`, `@noble/hashes`, and `multiformats` only. The sha2-256 hasher MUST be the browser build (`crypto.subtle`), not `node:crypto`. Sync Ed25519 uses `@noble/hashes` SHA-512. Tests MUST NOT mock signatures.

`verifyChain` (a `SoulStore` walk) is not part of this entry.

---

## Which key verifies what

| Bytes | Key | What a pass proves |
|-------|-----|--------------------|
| Record `sig` | Genesis `body.soul_pubkey` | The soul key signed the soul payload (envelope including `cosigners`, excluding `sig`). |
| Each `cosigners[]` entry | Door public key for `parseResidency(residency).doorId` | That Door signed `core` (envelope excluding `cosigners` and `sig`). |
| Arrival `body.session_pubkey` | (no separate signature) | The session key is authentic only because the arrival record itself verifies under the soul key and that Door's key. |
| Outbound `/door/session` frame `sig` | The open arrival's `session_pubkey` for this porch and `signed.epoch` (see [Porch lines](#porch-lines)) | The session key signed the canonical frame with `sig` omitted (`spec/door/api.md`). |
| Heartbeat `body.session_pubkey` | Must equal the open arrival's session key | A different key is `bad_session_continuity`. The chain is then not verified. |

**Chain of trust.** Genesis names the soul key. The soul key signs the arrival record, which publishes exactly one session public key for `(door_id, epoch)`. Later heartbeats must repeat that key. Outbound porch lines verify under it. A signature from any other key fails, even if the bytes are otherwise well formed. v0.1 has no second session key and no rotation: a later arrival is a new epoch, and a second arrival for the same epoch is `presence_conflict`.

Door public keys are not inside the record. Callers pass `doorPublicKeys` keyed by door id (`web:home`, not `door:web:home/epoch:1`). Cosigned records without that key fail `missing_cosigner`. They are not verified.

---

## Chain bytes

The shrine and the porch obtain an ordered record array and verify it with `verifyRecords`. They MUST NOT treat Atlas `verified: true` or `status` as a substitute.

**`GET {atlasUrl}/chain/export`** (CORS GET, same public error shape as the other Atlas routes) returns:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `records` | array | yes | Full OSP records in chain order. Not the `/records` summary list. |
| `doorPublicKeys` | object | yes | door id → base64url Ed25519 **public** key. Private keys are forbidden. |
| `blobs` | object | no | Journal side-blob CID → base64url bytes. Omitted CIDs are unavailable, not erased. |

`@npc/atlas` serves this route. The body has no `verified` and no `status` field. `blobs` includes journal side blobs (`journal_cid` on `journal` records and on shards). Shard `text_cid` blobs are omitted: they are not journals, and leaving them out does not fail verification. Atlas omits a blob whose CID is the `blob_cid` of any tombstone on the chain. A client that receives one anyway still renders `[journal erased]`.

The response SHOULD include an `ETag`, and SHOULD expose that header to cross-origin callers (`Access-Control-Expose-Headers: ETag`). A client SHOULD send the previous tag as `If-None-Match`. `304` (empty body, same `ETag`) means the previous successful body is unchanged and MUST be kept. A client with no previous success MUST NOT treat `304` as a chain. `Cache-Control: no-cache` means revalidate; it does not replace the shrine's 60-second refetch.

Absence of a blob does not fail `verifyRecords` (`spec/osp/records.md`). A verified `tombstone` whose `blob_cid` covers a journal means the prose is gone: render `[journal erased]` and never the bytes, even if a blob is still present.

---

## Replica shrine

A shrine is not a Door. It MUST NOT offer chat, `POST /api/say`, attest, heartbeat, or any presence claim of its own. One residency at a time is unchanged: the shrine only reads.

### Embed

One script element plus one config object. Embedders do not install a framework. The script is classic (a `src` URL), fetches only the configured Atlas (and does not load other scripts), and mounts into one element.

```html
<script
  src="https://porch.example/shrine.js"
  defer
  data-atlas-url="https://atlas.example"
  data-porch-url="https://porch.example"
  data-mount="#wanderer-shrine"
></script>
```

`data-atlas-url` is required (absolute `http:` or `https:` URL). It may be an Atlas origin or a porch origin that serves `GET /chain/export` (the web porch proxies that path to its server-side Atlas). `data-porch-url` is optional and is only a link, shown when the verified presence door is the web porch. `data-mount` defaults to `#wanderer-shrine`.

The same fields MAY be supplied as `globalThis.WANDERER_SHRINE` before the script runs. When both are set, the object wins for each field it sets. A field the object omits still comes from `data-*`. The object MAY also pin keys:

| Field | Required | Meaning |
|-------|----------|---------|
| `atlasUrl` | yes | Origin serving `GET /chain/export` (an Atlas, or a porch that proxies it). |
| `porchUrl` | no | Link only. |
| `mount` | no | CSS selector. Default `#wanderer-shrine`. |
| `soulPublicKey` | no | Base64url pin. If set, genesis `soul_pubkey` must equal it. |
| `doorPublicKeys` | no | If set, this map is the entire door-key set (it replaces the export's map; it is not merged). |

Without `soulPublicKey`, a pass proves the configured Atlas served an internally valid chain, not that the Atlas is the canonical Wanderer. The porch MUST pin `soulPublicKey` and its own door public key. Third-party shrines SHOULD pin the soul key when they know it.

### Badge

The badge text is exactly `PRESENT` or `ELSEWHERE` (uppercase, real text, not only a color). It is the first content in the widget. There is no config flag to hide it, swap it, or render journals without it.

| Condition | Badge | Also shown |
|-----------|-------|------------|
| `verifyRecords` valid, pinned soul key matches when set, and presence (below) is present | `PRESENT` | Optional quieter door id. Journals that pass the journal rules. |
| Chain valid, presence is traveling or sleeping, including a chain with no attestation (Atlas `GET /state` reports that as sleeping) | `ELSEWHERE` | The quieter word `traveling` or `sleeping`. Verified journals may still show. |
| Fetch failed, chain invalid, pin mismatch, or verification not finished | `ELSEWHERE` | The words `verification failed` once the attempt finished, or `checking` while it has not. No verified journals. |

`PRESENT` is forbidden until a completed `verifyRecords` call returned valid. A loading shrine is `ELSEWHERE` / `checking`, never a flash of `PRESENT`. Sleeping and traveling are both `ELSEWHERE`; the quieter word MUST NOT replace the badge.

Presence uses the verified records only, with the same scan as Atlas `GET /state`: newest `sleep` before any later attestation means sleeping; otherwise the newest `arrival` or `heartbeat` means present at that `door_id` and epoch; `departure`, `travel`, or `handover` means traveling. A chain with no attestation is sleeping. An invalid chain is not scanned for presence.

The widget renders inside a closed shadow root so page CSS cannot hide the badge while leaving journals visible. Hiding the host element hides the whole shrine (it cannot show journals alone). The shrine refetches `GET /chain/export` when the document becomes visible and at least every 60 seconds while it is open, so a departure does not stay `PRESENT` after the Atlas is reachable. Those refetches SHOULD send `If-None-Match` and keep the last verified snapshot on `304`.

### Journals

Shown only from a valid chain, after the badge, in the same shadow tree:

- **osp/0.2 `memory` / `journal`:** prose from blob bytes whose `sha256` is `journal_hash` and whose CID matches. Otherwise the journal is not verified prose.
- **osp/0.2 shard `journal_cid`:** a verified shard that carries both `journal_cid` and `journal_hash` (legacy embedded journal; both or neither) uses the same blob rules as an `osp/0.2` `journal` record. Shard `text` is never shown.
- **Verified tombstone** of that blob: `[journal erased]`.
- **osp/0.1 inline `journal`** on a verified shard: the inline string may be shown. Shard `text` is never shown.
- Unavailable blob, hash mismatch, or failed chain: do not show the prose as a journal.

The same `journal_hash`, or the same inline journal string, is shown once: the earliest in chain order. Later copies are omitted.

Journals are the published markdown only. No usernames, shard text, or other residency transcript.

### Never rendered as verified

The following MUST NOT appear as verified Wanderer speech, a verified journal, or `PRESENT`:

- Atlas `status` or `verified` when the browser has not accepted the chain.
- A record, journal, or outbound frame that failed signature, session-key, `prev`, or any other `ChainRule` check.
- Journal prose whose blob was not checked, or whose hash does not match.
- Tombstoned prose.
- Shard `text`, visitor chat, or system notices ("has arrived" / "has moved on").
- Any line while the state is `checking` or `verification failed`.

Unverified journals are omitted. They are not shown in a "failed" style that could be mistaken for the journal. A failed chain shows the badge and `verification failed` only.

---

## Porch lines

The porch already knows whether a session socket is bound. That flag is not a signature check. Each Wanderer line the page displays MUST carry the signed outbound frame:

| Field | Meaning |
|-------|---------|
| `signed` | The outbound frame object **without** `sig` (the exact value `canonicalize` covers). `type` is `outbound`. |
| `sig` | Base64url session-key signature over those canonical bytes. |
| `text` | The words on screen. MUST equal `signed.body.text` when text is shown. |

Before the line may be marked verified, the browser has a valid chain (soul pin matched) and `signed.door_id` equals this porch's configured door id. The session key is the open arrival for that door and for `signed.epoch`. Open is the same newest-first scan as Atlas `GET /state` and the shrine badge: a `sleep` newer than every attestation means sleeping and no line verifies; `departure`, `travel`, or `handover` means traveling and no line verifies; otherwise the newest `arrival` or `heartbeat` is present at that door and epoch. A newer arrival supersedes older epochs. The key is that arrival's `session_pubkey` (a heartbeat does not publish a second key). `verify(canonicalize(signed), sig, session_pubkey)` must be true over the original `signed` object, including fields a schema does not name. A reaction is verified only when `signed.body.reaction` is that emoji and target. A wrong session key, a wrong door, a departed, superseded, or sleeping epoch, a tampered byte, a malformed proof, or a text that does not match `signed.body.text` is a failed line. A malformed proof is `failed`. It does not throw.

The porch sends `If-None-Match` only while it still holds a verified export. A failed fetch, a failed verification, or a `304` that does not follow a verified snapshot drops that cache (no ETag and no verified snapshot). The next request is a full GET. A `304` after a verified snapshot reuses it, including when the Wanderer is sleeping or away and no line verifies. A failed fetch does not keep the previous snapshot as verified speech.

A failed Wanderer line stays on screen (it is not dropped) with the visible label `verification failed`. It MUST NOT use the verified-speech treatment. Visitor lines and system notices have no session signature and MUST NOT use that treatment either.

The porch page pins `soulPublicKey` and the door public keys needed to verify the chain. `atlasUrl` is the porch's own origin when `ATLAS_API_URL` is set: the browser fetches `GET /chain/export` from the porch, and the porch forwards only `If-None-Match` to Atlas. The browser is never given the server-side Atlas URL. It does not ask the visitor to trust the server's "this is the Wanderer" bit.

The porch loads those pins from its own origin (`GET /api/verify-pins`: soul public key, this door's public key, door id, and `atlasUrl`). It does not take the soul key or this door's key from the export. The export's entry for this door id must equal the pin; every other door id is taken from the export so a chain that has visited other Doors can still verify. A mismatch, a missing genesis, or a genesis `soul_pubkey` other than the pin fails every Wanderer line. The page refetches the export when the tab becomes visible and at least every 60 seconds, and SHOULD send `If-None-Match`, keeping the last verified snapshot on `304`.

---

## Out of scope

Session-key rotation, handover ceremony records as a new session key, invitations, community Door registration, and an Atlas-site redesign. Those stay on their own tasks. This contract is one session key per epoch: the key on the verified arrival.
