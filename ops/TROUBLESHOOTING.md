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
mirror from the file store at open (since v0.3.1). Before boot, move the stale B2 prefix
aside (the backup sidecar's shrink guard refuses to overwrite a longer chain with a
shorter, clean one). **Never `rclone purge` it** — the old chain and blobs are the only
off-host copy if the reseed turns out wrong. With the backup service stopped:

```bash
sudo docker compose --env-file ops/.env -f ops/compose.ghost.yml stop backup
# remote = BACKUP_RCLONE_REMOTE, e.g. ghost-remote:npc/soulchain
rclone move ghost-remote:npc/soulchain ghost-remote:npc/soulchain-archive-$(date -u +%Y%m%d) \
  --config /path/to/rclone.conf -v
rclone lsf ghost-remote:npc/soulchain --config /path/to/rclone.conf   # expect empty
```

On B2, `move` is a server-side copy + hide per object (Class C copy calls ≈ object
count — check the cap first, or raise it for the day). Restarting the sidecar after the
move does a full upload of the clean chain (sidecar state lives in its tmpfs `/tmp`, so a
container restart forgets the old prefix). Delete the archive prefix only after the new
chain has verified and a backup cycle completed.

### Crash loops append junk arrivals

Dual-append is file-first: every crash-retry cycle that gets past signing appends a real
signed arrival to the file chain. After any crash-loop session, inspect `chain.jsonl`
before assuming it is clean.

## Backups (B2)

### "Daily Class C Transactions Cap" alert at 75% / 100% (2026-10-04)

Before the fix, the backup sidecar re-authorized and listed B2 on every 5-minute
tick even when nothing had changed (3 rclone invocations ≈ 9 Class C calls per tick ≈
2,500/day idle) — exactly the free-account default cap. Once the cap trips, B2 refuses
calls until 00:00 GMT, so `lsjson` fails, the shrink guard refuses uploads, and the
backup container goes unhealthy; `key-backup.sh` shares the same account-wide cap.

- Confirm: B2 web UI → **Caps & Alerts** (Class C count) / **Reports** (per-API breakdown);
  `sudo docker logs <backup-container> 2>&1 | grep -iE "cap|403|refusing"`.
- Fix: upgrade the backup image (idle ticks are local-only). If `ops/.env` still carries
  the old `BACKUP_DEBOUNCE_SEC=5`, raise it to `30` (or delete the line to take the default).
- Raising the Class C cap in **Edit Caps** is a safe stopgap; Backblaze currently lists
  Class C calls as free — check the dialog's price before relying on that.

### Class C budget after the 2026-10 sidecar redesign

Expected steady state is a few hundred Class C calls/day (see RUNBOOK "Backup semantics"
estimate): heartbeat-only appends upload at most once per `BACKUP_HEARTBEAT_DEFER_SEC`,
new blobs are sent with `--files-from` (no remote listing), and a full listing happens
only on the daily verify and at container start. If the count is far higher:

- `docker logs <backup-container> | grep -c 'full check'` — many full cycles mean the
  container is restart-looping (each start = full verify) or `BACKUP_VERIFY_SEC` is low.
- Many `Copying chain.jsonl` lines with only heartbeats in between → `BACKUP_HEARTBEAT_DEFER_SEC`
  is unset/0 in `ops/.env`, or the runtime's heartbeat record shape changed (deferral only
  matches canonical `attestation` records with a flat `"kind":"heartbeat"` body; anything
  else uploads promptly by design — update `HEARTBEAT_ERE` in `backup-watch.sh`).

## Erasure (tombstoned blobs on B2)

Granted erasure requests (spec/osp/privacy.md §6) delete the blob locally and append a
`tombstone` record. The backup sidecar then deletes exactly the tombstoned `blob_cid`s
from `remote/blobs/` (after uploading the chain that carries the tombstone) and never
uploads them again. Verify after an erasure:

```bash
sudo docker logs <backup-container> 2>&1 | grep -E 'Erasure:|tombstone'
rclone lsf ghost-remote:npc/soulchain/blobs/ --include '<blob_cid>' --config /path/to/rclone.conf  # expect nothing
rclone lsf ghost-remote:npc/soulchain/blobs/ --b2-versions --include '<blob_cid>*' --config /path/to/rclone.conf
```

- Deletes use `--b2-hard-delete` (current version removed, not just hidden). Older
  versions, if any, are purged by the bucket lifecycle rule within a day, or immediately
  with `rclone cleanup ghost-remote:npc/soulchain/blobs --config …`.
- `WARN: … tombstone line(s) did not match the strict shape` — the tombstone's JSON is not
  the canonical `osp/0.2` shape (spec/osp/records.md); nothing was deleted remotely.
  Investigate the record; if the blob must go, delete that single object by hand with
  `rclone deletefile …/blobs/<blob_cid> --b2-hard-delete`.
- `WARN: tombstoned blob … is a chain record CID; refusing remote delete` — the CID is a
  record's own bytes (a `prev` link). Deleting it would break restores; this indicates a
  bad tombstone — do not delete by hand, open an issue.
- Under `osp/0.2`, `history/` copies of `chain.jsonl` contain only envelopes (CIDs,
  hashes, tombstones) — never side-blob prose — so erasure does not touch them.
- Erasure removes copies on infrastructure we control only (VPS + this bucket); volunteer
  IPFS copies cannot be recalled (privacy.md §5).
