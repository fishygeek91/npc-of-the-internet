# @npc/door-web

## 0.7.0

### Minor Changes

- f933118: The porch and shrine verify a chain incrementally: a refetch asks for the tail after the verified head, keeps one verifier, and drops that state for one full export when the cursor is unknown or the tail does not extend it. A full verify yields about every 50 ms so the page can paint.
- 65bf613: The porch forwards a validated `after` on `GET /chain/export`, keeps at most 16 tail bodies and 16 MiB of them, and answers extra concurrent tail fetches with `503` `atlas_busy`.
- 9a116f7: The web porch verifies each Wanderer line in the browser. A line that fails the session signature stays visible and is labeled verification failed. The porch also serves GET /chain/export from its own origin, so a browser never receives the server-side Atlas URL. Concurrent visitors share one Atlas fetch, a successful export is reused for a few seconds, and a cross-origin shrine may read that route without credentials.
- 362a1b1: door-web checks a porch line only against the open arrival at this Door. A departed, superseded, or sleeping epoch fails, a malformed proof fails closed, and a failed export fetch clears the ETag so the next request is a full GET. The porch page does not call this yet.
- 5688015: The first full verify on the porch page and the shrine runs in a blob-URL worker built from the same classic bundle. Records that worker accepted are parsed on the main thread in chunks that yield about every 50 ms. If the worker cannot start, it errors, or it stays silent for 120 seconds, it is terminated and verification continues in those chunks. `GET /shrine.js` sends `Access-Control-Allow-Origin: *` and does not send credentials; no other static asset sends that header.
- fd918c6: The web porch serves an embeddable read-only shrine. It shows PRESENT or ELSEWHERE only after the browser verifies the chain, and it renders a tombstoned journal as [journal erased].
- 70e1219: Atlas `GET /state`, the porch, and the shrine badge share one presence scan (`scanPresence`) and the per-epoch arrival lookup (`arrivalForEpoch`). A porch line still checks the arrival `session_pubkey` for its own epoch.
- 91682d6: A browser can turn a chain export into a shrine snapshot. PRESENT requires a verified present chain. A chain with no attestation is ELSEWHERE and sleeping, matching Atlas GET /state. A tombstoned journal reads as [journal erased].

### Patch Changes

- 7c32264: An oversized Atlas whereabouts response is remembered for 30 seconds, and a Door HTTP response over the client read cap is reported as door_unavailable.
- f94b184: Cap Door HTTP and WebSocket client reads, Atlas whereabouts fetches, and OpenAI-compatible model responses (the Wanderer's Brain and the Door memory witness) before JSON parsing.
- 1c8322d: Shutdown still exits when stop fails, later resources still close, HTTP 500 bodies stay generic, transcript errors omit filesystem paths, and Brain logs record only reason and numeric status.
- ca9c6e5: The porch verifies each Wanderer line against that epoch's arrival session key. The open epoch stays live speech, and a past epoch is marked as an earlier visit. A line newer than the verified snapshot stays checking until a debounced refetch, plus two short retries, has completed after the line was shown. Reaction chips follow that same checking, earlier-visit, and failed treatment.
- 61d581b: Private-key files are parsed once in osp-core (`parsePrivateKeyBytes`); soul and Door loaders and the preflight helper use that parser and `publicKeyFromPrivate`.
- 72ae887: The replica shrine keeps refreshing in a real browser. Timers, fetch, and document methods stay bound to the page, and the browser bundles build with door-web's own esbuild.
- 6fbf2b1: Finish the Zod 4 migration for the remaining packages and report "Expected integer" for a non-integer seq or epoch. Parsed config and protocol values are unchanged.
- Updated dependencies [64d4fbe]
- Updated dependencies [1163862]
- Updated dependencies [1949894]
- Updated dependencies [7c32264]
- Updated dependencies [f94b184]
- Updated dependencies [4080601]
- Updated dependencies [1c8322d]
- Updated dependencies [9ec50dc]
- Updated dependencies [99ce3e7]
- Updated dependencies [858f873]
- Updated dependencies [70e1219]
- Updated dependencies [61d581b]
- Updated dependencies [a614d25]
- Updated dependencies [1f4e7c4]
- Updated dependencies [8056980]
- Updated dependencies [6fbf2b1]
  - @npc/osp-core@0.7.0
  - @npc/door-sdk@0.7.0

## 0.6.0

### Minor Changes

- 4fcc330: Witnessed memory and travel between Doors (`door/0.2`). The Wanderer now lives at one Door at a time and moves on about once a day to a random Door that is online, never staying put while somewhere else is open. Its second Door is new: `@npc/door-web`, a public web porch that is open while the Wanderer is there and otherwise says where it went. No human approves memories any more, and there is no quarantine. At departure the Door where a memory formed co-signs it only after its independent AI witness has checked the memory against the Door's own record of what happened there. Witnessed memories are final as soon as they are appended. A memory the witness declines is kept only as a `rejected` record that gives the reason, never the text. Each residency's journal is written from witnessed memories only and is witnessed too (new osp/0.2 `journal` memory kind). Older `candidate` records still verify. On Discord, the review reactions are gone, and the bot posts when the Wanderer arrives and when it leaves.

  **Upgrade:** the runtime and both Doors must run the same release, because `door/0.2` is strict. Add `,web:home=<door pubkey>` to `ATLAS_DOOR_PUBKEYS`, using the same key as the Discord Door. The witness reuses the `NPC_BRAIN_*` settings when `NPC_BRAIN_PROVIDER=openai-compat`. The old `DISCORD_REVIEW_*`, `DOOR_COSIGN_RETAIN_*` and `NPC_QUARANTINE_*` settings no longer do anything. The daily move and the operator `depart` trigger are now on by default — delete any `NPC_RESIDENCY_OPERATOR_TRIGGER=0` / `NPC_RESIDENCY_MAX_MS=0` lines copied from an older `.env.example`, or they keep the Wanderer in place.

### Patch Changes

- Updated dependencies [4fcc330]
  - @npc/osp-core@0.6.0
  - @npc/door-sdk@0.6.0
