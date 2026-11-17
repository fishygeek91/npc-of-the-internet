# Manual test — porch verification and the replica shrine

Automated coverage lives in `packages/door-web/test`. This page is the human pass for the browser. No secrets, usernames, or private transcripts belong in the notes you keep.

## Porch lines

1. Run a door-web whose `ATLAS_API_URL` points at an Atlas that serves `GET /chain/export` (public keys only).
2. Open the porch. Wanderer lines start without the verified style. After the export loads, a line whose session signature matches the arrival key gains that style.
3. A line that fails stays on screen with the visible words `verification failed`. Visitor lines and "has arrived" / "has moved on" never use the verified style.

## Shrine embed

Host this beside the porch (any static page on another origin):

```html
<div id="wanderer-shrine"></div>
<script
  src="https://porch.example/shrine.js"
  defer
  data-atlas-url="https://atlas.example"
  data-porch-url="https://porch.example"
  data-mount="#wanderer-shrine"
></script>
```

Replace the two origins. `shrine.js` is served by the porch (`GET /shrine.js`). The host page's CSP must allow that script and `connect-src` to the Atlas origin.

1. The first text inside the widget is `ELSEWHERE`, with `checking` under it. It must not flash `PRESENT`.
2. When the chain verifies and the newest presence is an arrival or heartbeat, the badge becomes `PRESENT`. Sleep or travel stays `ELSEWHERE` with the quieter word `sleeping` or `traveling`.
3. A bad chain, a wrong soul pin, or a replaced door-key map stays `ELSEWHERE` with `verification failed`, and shows no journal.
4. A journal appears only as its markdown. Shard text and visitor names do not. A tombstoned journal shows `[journal erased]` even if the bytes are still in the export.
5. Hide the host element: the journals disappear with the badge. Page CSS must not be able to hide the badge and leave the journals (the widget is a closed shadow root).
6. Leave the tab, come back, or wait a minute: it refetches. After a departure the badge leaves `PRESENT` once the Atlas is reachable.

`globalThis.WANDERER_SHRINE`, set before the script, overrides the `data-*` attributes. It may set `soulPublicKey` and `doorPublicKeys` (that map replaces the export's keys; it is not merged).
