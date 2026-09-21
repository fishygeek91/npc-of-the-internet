# Ghost Ops Troubleshooting

Field notes from real incidents. Newest lessons first within each section. All commands
assume the VPS checkout at `~/npc` and the `ghostc` wrapper run via `sudo bash ops/scripts/ghostc.sh`
(preflight cannot read the uid-10001 keys as a normal user).

## Releases

### Merging the version-packages PR does NOT release (2026-09-20, v0.3.1 + v0.3.2)

`release.yml`'s `version` job only maintains the changesets "Version Packages" PR. The
`github-release` and `docker` jobs trigger on `v*` **tag push**, and nothing in the workflow
creates tags. After merging a version-packages PR, the operator must tag manually:

```bash
git checkout main && git pull
git tag vX.Y.Z <version-pr-merge-sha>
git push origin vX.Y.Z
```

Automation tracked in #150; until then this manual step is load-bearing.

### One docker leg red, others green → Trivy gate (2026-09-20, v0.3.1 atlas-api)

Each image is scanned independently; a fixable HIGH/CRITICAL anywhere in **that image's**
dependency tree fails only that leg (#127 policy), and the other images still publish.
To find the culprit, path-filter the workspace audit:

```bash
pnpm audit --prod --json   # then filter findings whose path starts with the shipped package
```

Notes from the v0.3.1 incident:

- `atlas-site` (astro chain) findings never enter the atlas-api image — ignore them for
  image triage.
- Root `pnpm.overrides` pins are themselves a liability: the pinned version can become the
  vulnerable one (fast-uri 4.1.2 did). Prefer `>=` floors over `=` pins for security
  overrides (#147/#148).

### Missing image on GHCR → compose silently builds locally

If `NPC_IMAGE_TAG` names an image that was never published (e.g. its release leg failed),
`ghostc up` falls back to **building it on the VPS** from the local checkout. The stack
comes up and looks healthy, but that service runs an unscanned local build. Check with
`ghostc ps` (IMAGE column) and gate upgrades on:

```bash
sudo docker manifest inspect ghcr.io/fishygeek91/npc-<svc>:vX.Y.Z >/dev/null && echo IMAGE_READY
```

## Discord door

### Bot connected + healthy but never responds

`discord_door_started` in the logs only proves gateway login. Silent unresponsiveness is
almost always one of these, checked in order:

1. **Wrong channel.** The door listens to exactly one guild + one channel
   (`DISCORD_GUILD_ID` / `DISCORD_CHANNEL_ID`); messages anywhere else — including **DMs,
   which can never work** (no DirectMessages intent) — are dropped silently with no log
   line. No @mention is needed in the bound channel. Compare the `.env` IDs against
   right-click → Copy Channel ID (Developer Mode on).
2. **Missing channel permissions.** Discord does not deliver message events for channels
   the bot cannot view. The bot role needs at least: View Channels, Send Messages, Read
   Message History, Add Reactions (cosign ✅/❌ reactions), Create Public Threads + Send
   Messages in Threads (`session.threads`). Symptom of missing View: bot absent from the
   channel's member sidebar while online in the server.
3. **Message Content Intent** off in the developer portal (bot receives events with empty
   content). Also confirm the portal app's Application ID matches the bot's user ID — a
   token from a different app than the one whose intents you toggled produces the same
   symptoms.
4. **PII screen.** The runtime immune layer drops inbound messages containing
   phone-number-like content before the brain sees them (`inbound_screened`,
   `categories:["pii.phone"]`, warn level). Working as designed.

Inbound-processing logs are **debug-level** and the door's pino level is hardcoded `info`
(`start.ts`), so a *successfully received* message is also invisible in logs until the
reply sends or an error fires. Absence of log lines does not distinguish deaf from working
— use the checks above, not the logs.

### Review gate ≠ reply approval

`review-gate.ts` gates **memory-shard cosigning** (✅/❌ reactions in
`DISCORD_REVIEW_CHANNEL_ID`, defaulting to the main channel; ignore = reject). Chat
replies post immediately and are not held for review.

## OpenRouter brain

### Every request 429 with a single Final Provider (2026-09-20, first contact)

`NPC_BRAIN_PROVIDER_ALLOWLIST` is intersected with the providers that actually serve
`NPC_BRAIN_MODEL`. If the intersection is one provider, that provider's saturation becomes
a total outage (429, `Attempts: 1`, no fallback). The original
`fireworks,together,deepinfra` list intersected to DeepInfra only — neither Fireworks nor
Together serves `deepseek/deepseek-v4-flash`.

**Always derive the allowlist from live endpoint data, never from assumption:**

```bash
curl -s https://openrouter.ai/api/v1/models/<author>/<slug>/endpoints \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(e.get('provider_name'), '|', e.get('tag') or e.get('name')) for e in d['data']['endpoints']]"
```

Then select the acceptable subset (Ghost policy: US-jurisdiction hosts, no China-based
inference, no fp4 quantization) and set the allowlist from the returned tags. Current
setting for `deepseek/deepseek-v4-flash` (verified 2026-09-20):
`deepinfra,gmicloud,venice,digitalocean,parasail,azure`.

Related gotchas:

- **Dated model pins shrink the provider pool** (fewer hosts serve a dated snapshot than
  the rolling slug). Use the undated slug in production and rely on the allowlist for
  routing control; the OpenRouter Activity page is the audit trail of who actually served
  each request.
- **Account-level Data Policy filters stack on top of the allowlist.** A ZDR-only routing
  toggle can shrink an otherwise healthy pool back to one endpoint. Keep the training-deny
  toggles on and unwanted providers in Ignored Providers; those carry the privacy
  guarantee without constraining routing.
- The runtime retries each inbound 3× (`inbound_brain_error` triples in the log = one user
  message).

## Soulchain / boot

### Reseeding after a bad chain

Genesis-only reseed of the **file volume only** — the DualSoulStore backfills the IPFS
mirror from the file store at open (since v0.3.1). Before boot, `rclone purge` the stale
B2 chain prefix: the backup sidecar's shrink-guard refuses to overwrite a longer chain
with a shorter (clean) one.

### Crash loops append junk arrivals

Dual-append is file-first: every crash-retry cycle that gets past signing appends a real
signed arrival to the file chain. After any crash-loop session, inspect `chain.jsonl`
before assuming it is clean.
