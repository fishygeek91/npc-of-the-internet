---
"@npc/door-web": minor
---

The web porch verifies each Wanderer line in the browser. A line that fails the session signature stays visible and is labeled verification failed. The porch also serves GET /chain/export from its own origin, so a browser never receives the server-side Atlas URL. Concurrent visitors share one Atlas fetch, a successful export is reused for a few seconds, and a cross-origin shrine may read that route without credentials.
