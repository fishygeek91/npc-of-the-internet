# Manual test — porch verification and the replica shrine

Automated coverage lives in `packages/door-web/test`. This page is the human pass in a browser. It has not been run yet. No secrets, usernames, or private transcripts belong in the notes you keep.

A public shrine needs Gate 2: either a public Atlas or a public porch. Do not publish `atlas-api`, and do not deploy this to the VPS from this pass. Localhost is enough.

## Bring the stack up

Ghost compose, from a checkout that already has `ops/.env` (names are in `ops/SECRETS.md`). Atlas stays on `127.0.0.1:8787`. The porch is on `127.0.0.1:8080`.

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d atlas-api door-web
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/api/verify-pins
curl -sI http://127.0.0.1:8080/chain/export
```

`atlasUrl` in the pins JSON must be `http://127.0.0.1:8080` (the porch you asked). It must not contain `atlas-api`.

Without compose, after `pnpm --filter @npc/osp-core --filter @npc/door-sdk --filter @npc/atlas --filter @npc/door-web build`, two processes:

```bash
ATLAS_CHAIN_DIR=/absolute/path/to/chain ATLAS_DOOR_PUBKEYS='web:home=<door pubkey>' ATLAS_PORT=8787 pnpm --filter @npc/atlas start
DOOR_KEY_PATH=/absolute/path/to/door.key SOUL_PUBLIC_KEY=<soul pubkey> ATLAS_API_URL=http://127.0.0.1:8787 DOOR_WEB_PUBLIC_PORT=8080 pnpm --filter @npc/door-web start
```

`ATLAS_CHAIN_DIR` is required by Atlas. `DOOR_KEY_PATH` and `SOUL_PUBLIC_KEY` are required by door-web. The same door public key must be in `ATLAS_DOOR_PUBKEYS`.

## Porch lines

Open `http://127.0.0.1:8080/`.

- Wanderer lines start without the verified style. After the export loads, a line whose session signature matches the open arrival gains that style.
- A line that fails stays on screen with the visible words `verification failed`.
- Visitor lines and the "has arrived" / "has moved on" notices never use the verified style.
- Hide the tab for a minute. The porch should not keep refetching while hidden. Show it again and it refetches.

`http://127.0.0.1:8080/chain/export` is the same export the page uses. A second load should send `If-None-Match` and may answer `304`.

## Shrine

Save this as `shrine.html` and serve it from another port so the script is cross-origin (`python3 -m http.server 8090` from that directory). Open `http://127.0.0.1:8090/shrine.html`.

```html
<div id="wanderer-shrine"></div>
<script
  src="http://127.0.0.1:8080/shrine.js"
  defer
  data-atlas-url="http://127.0.0.1:8080"
  data-porch-url="http://127.0.0.1:8080/"
  data-mount="#wanderer-shrine"
></script>
```

`data-atlas-url` is the porch origin. The porch proxies `GET /chain/export`. `OPTIONS /chain/export` answers `204` with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET`, and `Access-Control-Allow-Headers: If-None-Match`. The `GET` and `304` responses send that same origin and `Access-Control-Expose-Headers: ETag`, and never `Access-Control-Allow-Credentials`, so this page on port 8090 can read the export on port 8080. Do not point a public page at `http://atlas-api:8787`.

Expect:

1. The first text inside the widget is `ELSEWHERE`, with `checking` under it. It must not flash `PRESENT`. The badge is larger and bold. Page CSS must not restyle it (closed shadow root).
2. When the chain verifies and the newest presence is an arrival or heartbeat, the badge becomes `PRESENT`. Sleep or travel stays `ELSEWHERE` with the quieter word `sleeping` or `traveling`. A chain with no attestation is `ELSEWHERE` and `sleeping`.
3. A journal appears only as its markdown. Shard text and visitor names do not.
4. Hide the host element: the journals disappear with the badge.
5. Hide the tab: polling pauses. Show it again: it refetches.

`globalThis.WANDERER_SHRINE`, set before the script, wins per field. An object that only sets `soulPublicKey` still uses `data-atlas-url`. `doorPublicKeys` on the object replaces the export's map; it is not merged.

### Departure

With the runtime daemon up, end the residency (`wanderer depart` from `packages/runtime`, or the same command inside the runtime container). After Atlas shows the departure, hide the shrine tab and show it again. The badge becomes `ELSEWHERE` with `traveling`. The journal text can remain. An arrival after that returns the badge to `PRESENT`.

### Tombstone

This repo has no operator command that appends a tombstone. The automated test "renders a tombstoned journal as erased even when the bytes are still in the export" covers that case. On a chain that already contains a tombstone, the shrine shows `[journal erased]` for that journal and does not show the prose.

### Bad chain

Set a wrong soul pin and reload. The badge stays `ELSEWHERE` with `verification failed`, and no journal is shown:

```html
<script>
  globalThis.WANDERER_SHRINE = {
    soulPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  };
</script>
```

Remove that script and reload to see the verified badge again. Pointing `data-atlas-url` at `http://127.0.0.1:9` (nothing listening) is the failed-fetch case: same label, no journals.
