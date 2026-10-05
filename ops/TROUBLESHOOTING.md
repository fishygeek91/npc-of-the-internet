# Ghost Ops Troubleshooting

Field notes from real incidents. Newest lessons first within each section. All commands
assume the VPS checkout at `~/npc` and the `ghostc` wrapper run via `sudo bash ops/scripts/ghostc.sh`
(preflight cannot read the uid-10001 keys as a normal user).

## Releases

### How a release happens (automatic since #150; manual tagging bit v0.3.1 + v0.3.2)

Merging the changesets "chore: version packages" PR **is** the release. On that push to
`main`, `release.yml` runs:

1. `version` — maintains the Version Packages PR (no-op when no changesets are pending).
2. `tag` — reads the fixed-group version from `packages/osp-core/package.json`. If `vX.Y.Z`
   is not on origin and is newer than the highest plain `v*` tag, it pushes `vX.Y.Z` at the
   first-parent commit that introduced that version (the version-PR merge).
3. `github-release` + `docker` (Trivy-gated per image) — run **in the same workflow run**
   using the tag/sha from `tag`. A tag pushed with `GITHUB_TOKEN` never triggers a new run,
   so do not wait for a separate tag-push run; there will not be one.

Verify: Actions → Release → the run for the merge commit shows `version`, `tag` →
`github-release` + 4× `docker`, all green; the `tag` log has
`::notice::Tagged vX.Y.Z at <sha>`. Then gate the VPS upgrade on the image check below.

The workflow never cancels an in-progress run (`cancel-in-progress: false`), so a later
push to `main` cannot kill `docker` after the tag exists. If a run was dropped before it
started, the next push to `main` catches up and tags the original bump commit, not HEAD.

**Recovery / manual fallback** (still supported, same as before #150):

- Tag pushed but a leg failed (e.g. Trivy red): fix forward if needed, then Actions →
  that run → **Re-run failed jobs** (reuses the tag job's outputs).
- No tag at all (e.g. `tag` job failed, or repo rules block `GITHUB_TOKEN` from creating
  `v*` tags): push it yourself; a tag pushed with your credentials triggers its own run
  with `github-release` + `docker`:

  ```bash
  git checkout main && git pull
  git tag vX.Y.Z <version-pr-merge-sha>
  git push origin vX.Y.Z
  ```

- Re-publishing an existing tag is idempotent-ish: the GitHub Release body is updated in
  place and `:vX.Y.Z` / `:latest` are overwritten by a fresh Trivy-gated build of the same
  commit. Never move a tag to a different commit after images shipped.

### Version Packages PR shows no CI / Governance checks

The PR is opened and updated by `changesets/action` with `GITHUB_TOKEN`, and GitHub does
not start workflow runs for events created by that token, so `ci.yml` / `governance.yml`
never run on it (required checks then sit at "Expected — Waiting"). Workaround before
merging: **close and reopen the PR** in the UI (the `reopened` event is yours, so CI runs),
or push an empty commit to its branch with your own credentials:

```bash
git fetch origin changeset-release/main && git checkout changeset-release/main
git commit --allow-empty -m "ci: trigger checks" && git push origin HEAD
```

The next push to `main` regenerates the branch, so repeat after any further merge.

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

### Upgrading across the 2026-10 osp-core hardening

Strict tombstone rule 12, `"__proto__"` rejection and strict RFC 8032 are retroactive: a
v0.4.3-written chain that violates one opens fine on the old image and crash-loops on the
new one. Before switching `NPC_IMAGE_TAG`, run the **new** release's `osp verify` against a
snapshot ([RUNBOOK §4.3.1](RUNBOOK.md#431-gate-upgrading-across-the-2026-10-osp-core-hardening)).
If it fails, do not deploy — open an issue with the rule failures.

### `live .append.lock held by pid N on host H` after a container recreate

Since the 2026-10 hardening the append lock records the holder's hostname and process start
time. A same-host, same-PID lock from a previous process (container restart) is cleared
automatically; a lock from **another hostname** (e.g. a container that was recreated —
new container id — after crashing mid-append, or another container sharing the volume)
cannot be probed and is treated as live for up to an hour. Ghost compose pins the runtime's
`hostname: ghost-runtime`, so a plain recreate (image upgrade) is recognised as the same host;
this case only arises if that line was removed or another container mounts the volume.
If no other container uses the volume, stop the stack, delete `/data/soulchain/.append.lock` and/or
`/data/soulchain-ipfs/LOCK` (whichever the error names), and start again.

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
  A failing verify is retried as a full cycle at most once per `BACKUP_RETRY_SEC`
  (log: `Full cycle failed; next full attempt in …`); the container stays unhealthy until
  one succeeds.
- Many `Copying chain.jsonl` lines with only heartbeats in between → `BACKUP_HEARTBEAT_DEFER_SEC`
  is unset/0 in `ops/.env`, or the runtime's heartbeat record shape changed (deferral only
  matches canonical `attestation` records with a flat `"kind":"heartbeat"` body; anything
  else uploads promptly by design — update `HEARTBEAT_ERE` in `backup-watch.sh`).

## Erasure (tombstoned blobs on B2)

Granted erasure requests (spec/osp/privacy.md §6) delete the blob locally and append a
`tombstone` record. The backup sidecar then deletes exactly the tombstoned `blob_cid`s
from `remote/blobs/` (after uploading the chain that carries the tombstone) and does not
upload them again — unless identical prose is later re-appended (same CID, records.md
rule 12) and a record after the tombstone references it, which makes it a live blob again.
Verify after an erasure (the `--b2-versions` listing must be empty too — see RUNBOOK
"B2 lifecycle": the `blobs/` lifecycle rule is required for erasure):

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
