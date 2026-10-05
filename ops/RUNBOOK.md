# Ghost v0.2.2 — Operations Runbook

**What this document is:** day-two Compose stack ops for the Ghost deployment — services,
start/stop, logs/health, upgrade-with-verify, restore, crash recovery, and the residency
lifecycle (depart / re-arrive). Referenced by
[`LAUNCH.md`](LAUNCH.md).
**What this is not:** VPS provisioning, hardening, or `ghostc` host setup — see
[`RUNBOOK.ghost.md`](RUNBOOK.ghost.md).

Single-VPS Docker Compose stack for the NPC of the Internet Ghost deployment. All commands assume the repository root as the current working directory unless noted.

## Architecture

Four services share named Docker volumes from `ops/compose.ghost.yml`:

| Service | Image | Role | Volume access |
|---------|-------|------|------------------|
| **runtime** | `ghcr.io/fishygeek91/npc-runtime` | Residency daemon (`npc-runtime`): soulchain writer, Door HTTP/WS client, live Session loop | `soulchain` + `soulchain-ipfs` + `published` (read-write) |
| **door-discord** | `ghcr.io/fishygeek91/npc-door-discord` | Discord Door relay; HTTP REST and WebSocket coalesced on port **9090** | `door-state` (read-write; per-epoch cosign review state, §7.5) |
| **atlas-api** | `ghcr.io/fishygeek91/npc-atlas-api` | Read-only Atlas API on **127.0.0.1:8787** only (Docker published ports bypass ufw — see [RUNBOOK.ghost §6](RUNBOOK.ghost.md#6-keep-atlas-off-the-public-internet)) | `soulchain` + `published` (read-only) |
| **backup** | `ghcr.io/fishygeek91/npc-backup` | Append-triggered `rclone` backup to remote storage | `soulchain` only (read-only) |

Named volumes: `soulchain` (`/data/soulchain`), `soulchain-ipfs` (`/data/soulchain-ipfs`), `published` (`/data/published`), and `door-state` (`/data/door-state`, door-discord only). Host-mounted secrets (paths configured in `ops/.env`): soul private key, door private key, and `rclone.conf`. Only **runtime** writes the chain; **backup** backs up the file `soulchain` volume only (not the IPFS or published volumes).

Ghost compose always sets `NPC_SOULCHAIN_IPFS_DIR=/data/soulchain-ipfs`, so runtime opens `DualSoulStore` (file store authoritative, IPFS mirror). Compose also sets `NPC_PUBLISHED_CAR_PATH` and `NPC_MANIFEST_CID_PATH` under `/data/published` for Atlas CAR/manifest hooks. **Outbound** IPFS replication stays disabled by default (`NPC_REPLICATION_ENABLED` unset) — enabling is Gate 2; see [RUNBOOK.ghost §10a](RUNBOOK.ghost.md#10a-ipfs-replication-optional-gate-2-for-live-push) and `ops/SECRETS.md` for env names.

Runtime appends **`osp/0.2`** records natively. Fresh `osp init` already writes `osp/0.2` genesis (no migrate). Legacy `osp/0.1` chains need cutover before a writing runtime — see [RUNBOOK.ghost §9](RUNBOOK.ghost.md#9-osp02-cutover-required-before-ghost-runtime-after-119).

### Backup semantics

The backup sidecar (`ops/scripts/backup-watch.sh`) runs each upload cycle in this order (cycles are serialized by a lock in its state dir):

1. **Snapshot** `chain.jsonl`, then list `blobs/` (the runtime writes a blob before the chain line that references it, so the snapshot never references a blob the cycle did not see).
2. `blobs/` → remote `blobs/` with `rclone copy` — **never** `rclone sync`. Normal cycles send only blob entries (`name size`) not yet uploaded, via `--files-from <list> --no-traverse --no-check-dest` (content-addressed + immutable → idempotent, no remote listing). Force/verify cycles run a full checking `rclone copy` (self-heal). A failed blob copy aborts the cycle before the chain step.
3. **Size-regression guard:** if the snapshot is smaller than the remote tip, refuse with ERROR unless `ALLOW_CHAIN_SHRINK=1`. The remote size is the last uploaded size kept in local state; `rclone lsjson` (with bucket-remote empty-array handling) runs only on force/verify cycles or when that state is missing.
4. Snapshot → remote `chain.jsonl` (`rclone copyto`). At most once per `BACKUP_HISTORY_SEC` (default daily) it passes `--backup-dir ${remote}/history/<YYYYMMDDTHHMMSSZ>-<pid>` so the prior tip becomes a rollback point — and **always** when the snapshot is not a pure append of the last uploaded chain (shrink override, in-place `osp migrate`, operator restore, lost sidecar state), so a rewrite never overwrites the remote tip without a rollback point.
5. **Erasure propagation** ([`spec/osp/privacy.md`](../spec/osp/privacy.md) §6): blob CIDs named by tombstone records appended since the last upload (full chain rescan on force/verify) are deleted from remote `blobs/` with `rclone delete --files-from <exactly those CIDs> --b2-hard-delete` — only after the chain carrying the tombstone is on the remote. Lines must match the strict tombstone shape and CID format; a CID that is also a chain record CID is refused. Erased CIDs are not uploaded again — unless the same content-addressed blob is back on disk **and** a record after its last tombstone references it again (identical prose re-appended → same CID, allowed by [`records.md`](../spec/osp/records.md) rule 12); it is then a live blob, uploads normally and is not re-deleted by later rescans. See [TROUBLESHOOTING: Erasure](TROUBLESHOOTING.md#erasure-tombstoned-blobs-on-b2).
6. Touches `BACKUP_OK_PATH` (default `/tmp/backup.ok`) only after full success (or a policy skip, below).

Set `BACKUP_ONCE=1` to run one full (forced) cycle and exit (used by restore drills).

**Remote-call budget.** Every rclone invocation authorizes and usually looks up the bucket/object (B2 **Class C** calls; free accounts cap these at 2,500/day account-wide — the key-backup bucket shares the cap). Budget rules:

- **Unchanged** `blobs/` (set identity: digest of sorted `name size` list) and `chain.jsonl` (size + digest) → zero remote calls; `BACKUP_OK_PATH` is still refreshed (unless a full-cycle failure is outstanding, below).
- **Heartbeat deferral.** The runtime appends a signed heartbeat attestation (1 chain line + 1 record blob) every 10 minutes. If *every* record appended since the last uploaded chain is a heartbeat (or only unreferenced blobs changed), the cycle makes no remote calls until `BACKUP_HEARTBEAT_DEFER_SEC` (default 1 h) after the last successful chain upload; the periodic loop wakes for that deadline, so a heartbeat reaches the remote within the window. **The healthcheck stays green while deferring** — by policy a remote that lags by ≤ 1 h of heartbeats is current enough; a crash in that window loses at most those heartbeats (presence proofs, not memories). Any other record (memory, tombstone, arrival/departure, …) uploads after the `BACKUP_DEBOUNCE_SEC` debounce.
- **Full verify** every `BACKUP_VERIFY_SEC` (default 1 day) and at startup: checking blob copy + `lsjson` + `copyto` + tombstone rescan, so a revoked key, deleted bucket or lost object surfaces and heals.
- A failing unchanged cycle backs off to `BACKUP_RETRY_SEC` (default 15 min); new appends retry immediately (as incremental cycles).
- A failing **full** cycle (verify, or the startup round-trip) is retried as a full cycle at most once per `BACKUP_RETRY_SEC`, whatever changes locally; in between, cycles run incrementally (new appends still upload). Only each container start (and `BACKUP_ONCE`) always runs a full cycle. While a full-cycle failure is outstanding, `BACKUP_OK_PATH` is **not** refreshed — not even by incremental successes — so the healthcheck (marker < 900 s) turns unhealthy until a full retry succeeds; look for `Full cycle failed; next full attempt in …` in the sidecar log.

**Estimate** (≈3 Class C per rclone invocation: authorize + bucket/object lookup; list pages add 1 per 1,000 objects):

| Event | Invocations | Class C |
|---|---|---|
| Upload cycle (new blobs + chain) | `copy --files-from` + `copyto` | ≈ 6 |
| Heartbeat-only hours | ≤ 1 flush/hour, only when nothing else uploaded that hour | ≤ 24 × 6 ≈ 144/day |
| Daily verify (and each container start) | full `copy` (+ ⌈blobs/1000⌉ list pages) + `lsjson` + `copyto` (+ history copy) | ≈ 12 + blobs/1000 |
| Erasure | `delete --files-from` | ≈ 3 + 1 lookup per CID |

So a day with *B* conversation bursts costs ≈ 6·B + 144 + 12 + blobs/1000 — e.g. 30 bursts and 20k blobs ≈ 180 + 144 + 32 ≈ **360/day** (previously ≈ 9+ per heartbeat ≈ 1,300+/day and growing with blob count, because every upload listed all remote blobs). Regression test: `ops/scripts/backup-watch-budget-test.sh` (CI; `BUDGET_TEST_MODE=poll|busybox` for fallback paths).

Remote layout:

```
${BACKUP_RCLONE_REMOTE}/
  blobs/
  chain.jsonl
  history/<UTC>-<pid>/chain.jsonl   # ≤ 1 per BACKUP_HISTORY_SEC
```

Blobs are uploaded before the chain file so a restore never references blob CIDs that have not yet reached the remote. The `history/` tree is the anti-clobber guarantee — B2 bucket versioning is **not** required for it. After any restore, always run `osp verify` before starting the stack. If a crash left a torn trailing line or a stale `.append.lock`, recover with `FileSoulStore.openWithRecovery` (see [Crash recovery](#6-crash-recovery)) before verifying.

**B2 lifecycle / retention (required for erasure on `blobs/`).** B2 buckets default to *keep all versions*: every `chain.jsonl` overwrite leaves the previous upload as a hidden version, and rclone's `--backup-dir` (server-side copy + hide) and deletes do the same, so storage grows without bound and erased blobs could survive as hidden versions. In the B2 web UI → Bucket Settings → Lifecycle Settings, add custom rules with **non-overlapping** prefixes (`<path>` = the path part of `BACKUP_RCLONE_REMOTE`, e.g. `soulchain`):

| `fileNamePrefix` | `daysFromUploadingToHiding` | `daysFromHidingToDeleting` | Effect |
|---|---|---|---|
| `<path>/chain.jsonl` | — | 1 | keep only the last version of the live tip (`history/` holds rollback points) |
| `<path>/blobs/` | — | 1 | hidden/old blob versions (incl. erased ones) are purged within a day |
| `<path>/history/` | 30 | 1 | ≈ 30 daily rollback points, then purged |

The sidecar deletes erased blobs with `--b2-hard-delete`, which removes the current version immediately; the lifecycle rule cleans up any older versions within a day (or run `rclone cleanup <remote>/blobs` on the host after an erasure to purge old versions of every blob immediately).

**Erasure needs the `blobs/` lifecycle rule — it is not optional.** Incremental cycles upload new blobs with `--no-check-dest` (no remote lookup), so a blob re-sent after a partially failed cycle becomes a *second B2 version* of the same name, and `--b2-hard-delete` may remove only the newest version: the older copy of the erased bytes then survives as a hidden version until the "keep only the last version" rule (`<path>/blobs/`, `daysFromHidingToDeleting: 1`) purges it. After every erasure, confirm no version of the CID remains (wait for the lifecycle run, or `rclone cleanup <remote>/blobs` first):

```bash
rclone ls ghost-remote:npc/soulchain/blobs/ --b2-versions --include '<blob_cid>*' --config /path/to/rclone.conf   # expect no output
```

---

## 1. Start

### 1.1 Create environment file

```bash
cp ops/.env.example ops/.env
```

Edit `ops/.env` and replace every `replace-me` placeholder. At minimum you need valid `DISCORD_BOT_TOKEN`, a Brain key (`NPC_BRAIN_API_KEY` for the recommended OpenRouter path, or `ANTHROPIC_API_KEY` if `NPC_BRAIN_PROVIDER=anthropic`), and production key material. See `ops/SECRETS.md` for variable names and purposes.

### 1.2 Create host key files and rclone config directory

> **Warning — local smoke tests only for soul keys.** The `openssl rand` soul-key path below is for local smoke tests only. Real genesis uses `osp init` (see [`LAUNCH.md`](LAUNCH.md) §1 and §2). Do not use `openssl rand` to create the production soul private key.

Default paths from `ops/.env.example` (override with `SOUL_KEY_HOST_PATH`, `DOOR_KEY_HOST_PATH`, and `RCLONE_CONFIG_HOST_PATH` if you prefer different locations):

```bash
mkdir -p /tmp/npc-ghost/keys /tmp/npc-ghost/rclone

# Soul private key — 32 raw bytes or base64url text (mode 0600)
# Local smoke tests only — real genesis uses `osp init` (see LAUNCH.md):
openssl rand -out /tmp/npc-ghost/keys/soul.key 32
chmod 600 /tmp/npc-ghost/keys/soul.key

# Door private key — same format (door keys may use openssl; soul key must not for real launch)
openssl rand -out /tmp/npc-ghost/keys/door.key 32
chmod 600 /tmp/npc-ghost/keys/door.key

# rclone remote config (credentials live here, never in the repo)
touch /tmp/npc-ghost/rclone/rclone.conf
chmod 600 /tmp/npc-ghost/rclone/rclone.conf
```

On Linux (CI, VPS), bind mounts preserve host ownership — containers run as
`npc` (uid/gid **10001**) and must be able to read these paths:

```bash
sudo chown -R 10001:10001 /tmp/npc-ghost/keys /tmp/npc-ghost/rclone
chmod 700 /tmp/npc-ghost/keys /tmp/npc-ghost/rclone
```

Docker Desktop on macOS remaps ownership and often works without this step;
on Linux it is required.

Set `SOUL_PUBLIC_KEY` in `ops/.env` to the base64url public key that matches `soul.key`. Set `ATLAS_DOOR_PUBKEYS` to `doorId=base64url` bindings that match `door.key` (comma-separated if multiple doors; door id must match `CURRENT_DOOR_ID` for the active residency).

Configure `BACKUP_RCLONE_REMOTE` to point at the remote defined in `rclone.conf` (for example `ghost-remote:npc/soulchain`).

### 1.3 Build and start the stack

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d --build
```

**Expected behavior after start:**

- **runtime** runs `node dist/daemon.js` (image `CMD`; `pnpm deploy` does not emit an `npc-runtime` bin shim). It opens the soulchain, connects to door-discord on the compose network (`DOOR_HTTP_HOST` / `DOOR_HTTP_PORT`), arrives at the Door, and binds the session WebSocket. Logs `residency_live` after the first successful bind. Requires a valid soulchain (genesis or restored) and matching `SOUL_PUBLIC_KEY` / `ATLAS_DOOR_PUBKEYS` / `CURRENT_DOOR_ID`.
- **door-discord** runs `node dist/server.js` (image `CMD`; `pnpm deploy` does not emit a `door-discord` bin shim). It requires a real `DISCORD_BOT_TOKEN` and valid guild/channel IDs to stay healthy. Without them the container will crash-loop.
- **atlas-api** runs `node dist/server.js` (image `CMD`; same `pnpm deploy` own-bin trap). Compose publishes it on `127.0.0.1:8787` only (not all interfaces). It serves on `http://127.0.0.1:8787` once the soulchain volume contains a valid chain (empty volume returns errors until genesis).
- **backup** watches the soulchain volume and backs up to `BACKUP_RCLONE_REMOTE` when changes are detected.

**Image entrypoint smoke (no Discord / incomplete env):** after `docker compose … build`, one-shot runs with placeholder env confirm each image `CMD` is `node dist/…`, not a missing bin shim:

- **runtime:** logs structured `boot_failed` naming a missing/invalid var (e.g. `ATLAS_DOOR_PUBKEYS`) — **not** `npc-runtime: not found`. Expect `CMD ["node", "dist/daemon.js"]`.
- **door-discord:** exits with structured `boot_failed` — **not** `door-discord: not found`. Expect `CMD ["node", "dist/server.js"]`.
- **atlas-api:** does not die with `atlas-api: not found`. Expect `CMD ["node", "dist/server.js"]`.

The runtime healthcheck probes `/tmp/npc-runtime.ready` (override with `NPC_RUNTIME_READY_FILE`). The file is present only while the session WebSocket is connected (cleared on disconnect/reconnect backoff, rewritten on rebind). Compose allows up to 90s start period before marking unhealthy.

**SIGTERM / graceful stop:** `docker compose stop runtime` (or `down`) sends SIGTERM. The daemon removes the ready file, closes the WebSocket, calls `session.stop()`, drains pending soulchain appends, releases the writer lock, and exits (even if shutdown steps throw). It does **not** run ceremonial depart (no distill, cosign, or departure attestation). On-chain, the chain therefore shows no departure record — the stop looks like an abrupt crash. The next boot assigns a **new epoch** and arrives without distill/shard cosign. Use `wanderer move` for a deliberate handover.

### 1.4 Soulchain volume writability smoke test

Required after the `npc-runtime` CMD swap (and on any fresh volume). The runtime image pre-creates `/data/soulchain` owned by `npc` so a **fresh** named volume inherits write access for `USER npc`. Confirm:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
  --entrypoint sh \
  runtime -c "touch /data/soulchain/.wtest && rm /data/soulchain/.wtest"
```

Exit code `0` means the volume is writable. If this fails with `Permission denied`, the volume was likely created by an older image as `root:root` — either recreate it (`docker compose … down -v` then `up`, **destroys data**) or fix ownership once:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps --user root \
  --entrypoint sh \
  runtime -c "chown -R 10001:10001 /data/soulchain"
```

Images that predate the uid **10001** pin may leave an existing named volume
owned by the old system uid (~999) instead of `root:root`. The same one-shot
`chown` fixes that; fresh Gate-2 installs never hit this.

---

## 2. Stop

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml down
```

The named volume `soulchain` (project-prefixed as `npc-ghost_soulchain` on disk) is **retained** unless you pass `-v`:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml down -v
```

Use `-v` only when you intend to destroy all soulchain data on this host.

---

## 3. Logs and health

### 3.1 Service logs

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs -f runtime
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs -f door-discord
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs -f atlas-api
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs -f backup
```

Follow all services:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs -f
```

### 3.2 Atlas API health

```bash
curl -sS http://127.0.0.1:8787/state
```

A healthy response is JSON describing present/traveling/sleeping state derived from the soulchain. Connection refused means atlas-api is not running or not bound to 8787.

### 3.3 Runtime readiness

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml ps runtime
```

`healthy` means `/tmp/npc-runtime.ready` exists — i.e. the session **WebSocket is currently connected**, not merely that the daemon process booted. During a WS drop + reconnect backoff the probe flips `unhealthy` until rebind, and likewise for the travel gap of a residency cycle ([§7](#7-residency-lifecycle)). Follow logs for `residency_live` / `ws_session_ready` / `ws_session_disconnected`:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs runtime 2>&1 | grep -E 'residency_live|ws_session_'
```

### 3.4 Door coalesced HTTP + WebSocket

door-discord listens on a **single** port for both REST and WebSocket (`DOOR_HTTP_HOST` / `DOOR_HTTP_PORT`, default `0.0.0.0:9090` inside the container). Confirm both listeners in logs:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs door-discord 2>&1 | grep -E 'door_http_listening|door_ws_listening'
```

You should see `door_http_listening` and `door_ws_listening` both reporting port **9090**. The port is not published to the host in the default compose file; runtime reaches it on the internal Docker network.

### 3.5 Backup activity

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs backup 2>&1 | tail -20
```

After a change, look for `Copying N new blob(s)` / `Copying blobs/ … (full check` (startup and daily verify) and/or `Copying chain.jsonl`, then `Sync complete (marker`. Heartbeat-only periods log one `Deferring heartbeat-only change …` line per window and upload at most hourly; idle periods log nothing (see [Backup semantics](#backup-semantics)). Erasures log `Erasure: deleting N tombstoned blob(s)`.

---

## 4. Upgrade with verify

Always verify the soulchain **before** stopping for an upgrade and **again** after the new stack is up. Never skip pre-upgrade verification — it establishes a known-good baseline.

### 4.1 Install osp CLI (host)

From a fresh clone:

```bash
pnpm install --frozen-lockfile
pnpm --filter @npc/osp-cli build
```

### 4.2 Snapshot the soulchain volume for verification

The soulchain lives in a Docker named volume. Copy it to a host directory for `osp verify`:

```bash
mkdir -p ./_soulchain-snapshot
docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
  -v "$(pwd)/_soulchain-snapshot:/work/_soulchain-snapshot" \
  --entrypoint sh \
  runtime -c "cp -a /data/soulchain/. /work/_soulchain-snapshot/"
```

Alternative if a runtime container is already running:

```bash
RUNTIME_CID="$(docker compose --env-file ops/.env -f ops/compose.ghost.yml ps -q runtime)"
docker cp "${RUNTIME_CID}:/data/soulchain/." ./_soulchain-snapshot/
```

### 4.3 Pre-upgrade verify

Pass door public key bindings from `ATLAS_DOOR_PUBKEYS` in `ops/.env` (each `doorId=base64url` value is one `--door-key` flag):

```bash
node packages/osp-cli/dist/cli.js verify ./_soulchain-snapshot \
  --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
```

If you have multiple door keys, repeat `--door-key` for each binding in `ATLAS_DOOR_PUBKEYS`. For the offline fixture chain used by the restore drill, read bindings from `packages/atlas/test/fixtures/multi-residency/fixture-meta.json` (`doorPublicKeys` object) — those are TEST-ONLY fill-byte keys, not production secrets.

Exit code `0` means the chain is valid. Exit code `1` means verification failed (printed rule failures). Exit code `2` means corruption or I/O error — see [Crash recovery](#6-crash-recovery) before proceeding.

### 4.3.1 Gate: upgrading across the 2026-10 osp-core hardening

The 2026-10 osp-core hardening (strict tombstone rule 12, `"__proto__"` key rejection, strict RFC 8032 signatures) applies to records **already on the chain**: a chain written by v0.4.3 or earlier that violates a new rule verified before but will fail to open after the upgrade (runtime crash-loop). Before switching `NPC_IMAGE_TAG` to a release containing it, run the **new** release's `osp verify` against a snapshot: check out the new release tag, rebuild the CLI (§4.1), then repeat §4.2–4.3. If it does not exit `0`, **do not deploy** — keep the current tag and open an issue with the printed rule failures.

### 4.4 Bump image tag and deploy

After §4.1–4.3 establish a verifying baseline, deploy the new release:

1. Bump `NPC_IMAGE_TAG` in `ops/.env` to the release tag (for example `v0.2.2`). Pin a tag; avoid `latest` in production.
2. Pull and restart per [RUNBOOK.ghost §10](RUNBOOK.ghost.md#10-routine-operations):

```bash
# On the VPS (ghostc wraps compose + preflight):
ghostc pull && ghostc up -d
```

That is the **only** production upgrade path. Do not use a separate `docker compose pull` / `up -d --build` procedure for releases — it diverges from the host runbook.

**Dev smoke only (not an upgrade path):** when iterating on local images, set `NPC_IMAGE_TAG=local` in `ops/.env` and build/tag images yourself; still run §4.2–4.3 / §4.5 verify around any chain-touching restart.

### 4.5 Post-upgrade verify

Repeat steps 4.2 and 4.3 on a fresh snapshot. The post-upgrade chain must verify with the same exit code `0` as the pre-upgrade baseline.

```bash
rm -rf ./_soulchain-snapshot
mkdir -p ./_soulchain-snapshot
docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
  -v "$(pwd)/_soulchain-snapshot:/work/_soulchain-snapshot" \
  --entrypoint sh \
  runtime -c "cp -a /data/soulchain/. /work/_soulchain-snapshot/"

node packages/osp-cli/dist/cli.js verify ./_soulchain-snapshot \
  --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
```

Confirm Atlas responds:

```bash
curl -sS http://127.0.0.1:8787/state
```

---

## 5. Restore from backup

### 5.1 Offline restore drill (development / CI)

The repository ships a self-contained drill that needs no network. It seeds a fixture chain, simulates backup upload and restore via a local rclone remote, runs `osp verify`, and exercises **anti-clobber** semantics (size-regression refuse, blob immutability, `history/` tip archival):

```bash
bash ops/scripts/restore-drill.sh
```

This must pass on a machine with `rclone` and `pnpm` installed. Use it to validate your toolchain before attempting a production restore.

### 5.2 Production restore

Production restore replaces the local soulchain directory with data from the `BACKUP_RCLONE_REMOTE` defined in `ops/.env`.

**Stop the stack** so nothing holds the volume:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml down
```

**Restore to a staging directory on the host** (never sync directly into a running container):

```bash
RESTORE_DIR="$(pwd)/_soulchain-restored"
mkdir -p "${RESTORE_DIR}"

rclone sync "${BACKUP_RCLONE_REMOTE}/blobs" "${RESTORE_DIR}/blobs" \
  --config /tmp/npc-ghost/rclone/rclone.conf

rclone copyto "${BACKUP_RCLONE_REMOTE}/chain.jsonl" "${RESTORE_DIR}/chain.jsonl" \
  --config /tmp/npc-ghost/rclone/rclone.conf
```

Replace `/tmp/npc-ghost/rclone/rclone.conf` with your `RCLONE_CONFIG_HOST_PATH` if different. Substitute the remote name from `BACKUP_RCLONE_REMOTE` (for example `ghost-remote:npc/soulchain`). Pull direction may use `rclone sync` for blobs and `rclone copyto` for the chain tip — that is safe because restore is remote→local only.

**If the live tip is bad** but an older snapshot exists under `history/`, list archived tips and restore from one:

```bash
rclone ls "${BACKUP_RCLONE_REMOTE}/history" --config /tmp/npc-ghost/rclone/rclone.conf

# Pick a UTC folder from the listing, then:
HISTORY_TS="20250729T153045Z"
rclone copyto "${BACKUP_RCLONE_REMOTE}/history/${HISTORY_TS}/chain.jsonl" \
  "${RESTORE_DIR}/chain.jsonl" \
  --config /tmp/npc-ghost/rclone/rclone.conf
```

Still pull `blobs/` from the live remote (content-addressed; unchanged across tip overwrites).

**Verify before writing to the volume:**

```bash
node packages/osp-cli/dist/cli.js verify "${RESTORE_DIR}" \
  --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
```

If verification fails with exit code `2` and mentions a torn trailing line, run recovery (section 6) on `${RESTORE_DIR}` first, then verify again.

**Copy verified data into the volume** via a one-shot container:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
  -v "${RESTORE_DIR}:/work/restored:ro" \
  --entrypoint sh \
  runtime -c "rm -rf /data/soulchain/* && cp -a /work/restored/. /data/soulchain/"
```

**Start and confirm:**

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d
curl -sS http://127.0.0.1:8787/state
```

---

## 6. Crash recovery

Two common failure modes after an unclean shutdown:

1. **Stale `.append.lock`** — left when runtime crashed mid-append. `FileSoulStore.open` refuses to proceed while the lock exists. The lock file contains JSON `{"pid":<number>,"acquiredAt":"<ISO-Z>"}`.
2. **Torn trailing line in `chain.jsonl`** — a partial JSON line at the end of the file from a crash during write. The chain is incomplete and must be truncated to the last complete record. Trailing blank lines (`record\n\n`) are also stripped during recovery.

There is no `osp recover` command. Recovery uses `FileSoulStore.openWithRecovery` from `@npc/osp-core`, which removes a **stale** lock (dead PID, lock older than 1 hour, or legacy empty/unparseable lock), truncates a torn/blank tail, and opens the store. If the lock names a **live** process and is still fresh, recovery refuses with `ConcurrentAppendError` so it cannot steal a lock mid-append.

**Do not run `openWithRecovery` while another process may still be appending** to the same directory. Lock clearing is check-then-unlink (TOCTOU); concurrent recovery vs a live appender is out of scope for v0.1 single-host ops. Always `compose … down` first (below).

### 6.1 Recover on a host directory

Stop the stack first:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml down
```

Snapshot the volume to a host path (see section 4.2), then run recovery from the repository root with built packages:

```bash
pnpm --filter @npc/osp-core build

node --input-type=module -e "
import { FileSoulStore } from './packages/osp-core/dist/index.js';
const dir = process.argv[1];
const { store, truncatedBytes } = await FileSoulStore.openWithRecovery(dir);
await store.close();
console.log('Recovery complete. truncatedBytes=' + truncatedBytes);
" ./_soulchain-snapshot
```

If `truncatedBytes > 0`, a torn or blank tail was removed. A stale lock is removed only when safe (see above).

### 6.2 Verify after recovery

```bash
node packages/osp-cli/dist/cli.js verify ./_soulchain-snapshot \
  --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
```

### 6.3 Write recovered data back and restart

After verification succeeds, copy the recovered directory into the volume (same pattern as section 5.2) and start the stack:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
  -v "$(pwd)/_soulchain-snapshot:/work/recovered:ro" \
  --entrypoint sh \
  runtime -c "rm -rf /data/soulchain/* && cp -a /work/recovered/. /data/soulchain/"

docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d
```

**Operational note:** truncating a torn tail discards the incomplete record. That is correct crash-only semantics — the partial append never committed. After recovery, check backup remote freshness; if the remote tip still holds the torn line, restore from `history/<UTC>-<pid>/chain.jsonl` or re-upload with `ALLOW_CHAIN_SHRINK=1` only after confirming the smaller local chain is correct (backup uploads blobs-first, so a torn local tail may not yet have been uploaded).

---

## 7. Residency lifecycle

The core loop **reside → distill → publish → move** runs inside the runtime daemon. In v0.1
there is one Door, so "move" means: leave the Discord Door and **re-arrive at the same Door
under the next epoch**. Nothing happens on its own: **every trigger is off by default**, and
turning one on is an operator decision (Gate 2 — see [`LIFECYCLE.md`](../LIFECYCLE.md)).

### 7.1 What one cycle does

1. **Detach.** The runtime closes its session WebSocket. From here until re-arrival the
   Wanderer hears nothing: Discord messages in the travel gap are **dropped, not queued**
   (they belong to neither residency). `ghostc ps` shows runtime `unhealthy` for the gap —
   expected: the ready file means "session socket connected".
2. **Distill.** The in-memory transcript of this residency (never on disk) is screened,
   distilled into 5–20 candidate memory shards by the Brain, then destroyed.
3. **Host review in Discord.** door-discord posts one `**Cosign review** — shard …` message
   per candidate in `DISCORD_REVIEW_CHANNEL_ID` (or the residency channel). An operator from
   `DISCORD_OPERATOR_IDS` reacts ✅ / ❌ (or `/wanderer approve|reject <shard_id>`). No
   decision within `DISCORD_REVIEW_TIMEOUT_MS` (default 4 min) **rejects** the shard.
4. **Journal.** The Wanderer writes its residency journal from the **approved** shards only
   (rejected prose never reaches it) to `NPC_JOURNAL_DIR`
   (`/data/published/journals/journal-<door>-epoch-<n>.md`). Atlas does not read this file —
   Atlas `/journals` shows a journal only once it is on chain (step 7).
5. **Records.** Appended to the soulchain: `memory` `kind: rejected` (immune-screen drops,
   host rejections — category only), `memory` `kind: candidate` per approved shard,
   then `attestation` `departure` (Door co-signed) and `travel` (`to_door_id` = same Door).
   Atlas `/state` reports `traveling`.
6. **Re-arrive** — right away; the Wanderer does not wait out the quarantine window
   (door-discord keeps the epoch's review per epoch, in its `door-state` volume, so the
   candidates can be committed later while the next residency is live — 7.5). `hello` → `arrival` at `epoch + 1` (the Door retired the old epoch at
   departure and accepts any epoch above the last it saw) → new session socket → `residency_live`
   and `ws_session_ready` in the logs, runtime `healthy` again. The new residency starts with an
   empty transcript and no conversation history.
7. **Commit sweep (optional, off by default).** With `NPC_QUARANTINE_COMMIT_INTERVAL_MS` set,
   the live runtime checks on that timer for candidates of past epochs that have ripened
   (`NPC_QUARANTINE_WINDOW_MS`, default 24 h) and promotes them to `memory` `kind: shard` with
   Door co-signatures; the first shard of a residency carries its journal (side blob, read back
   from `NPC_JOURNAL_DIR`), which is what makes it appear on Atlas. See 7.5.

**Failure handling.** A failed depart (Brain error, too few shards, Door/review timeout) is
retried twice (after 30 s and 120 s; Bug #69 retry semantics: the cosign review is joined or
replayed, never re-posted). If it still fails the residency is **abandoned**: no departure
records, the next arrival supersedes it — the same chain shape as a crash, and that
conversation's memories are lost (`residency_depart_abandoned` at `error`). Re-arrival retries
with backoff (5 s → 5 min) until the Door answers. `SIGTERM` during a cycle (e.g.
`ghostc restart runtime`) aborts it cleanly: no re-arrival from the dying process, appended
records stay valid, and the next boot arrives at a fresh epoch as after any restart
(candidates appended before the stop are still committed by the next boot's sweep — the Door
retains their review, also across its own restarts thanks to the `door-state` volume).

### 7.2 Run a cycle by hand (operator trigger)

Enable it once in `ops/.env`, then recreate runtime:

```bash
# ops/.env
NPC_RESIDENCY_OPERATOR_TRIGGER=1
```

```bash
ghostc up -d runtime
ghostc logs runtime 2>&1 | grep residency_lifecycle_config   # operatorTrigger: true
```

Trigger a cycle (have an operator ready in Discord for the review posts):

```bash
ghostc exec runtime node dist/cli.js depart
# Depart requested: the daemon accepted the request.
ghostc logs -f runtime 2>&1 | grep -E 'residency_|ws_session_'
```

`depart` drops a request into `NPC_CONTROL_DIR` (`/tmp/npc-control`, tmpfs) and waits up to
15 s for the daemon to pick it up. Exit `1` ("No running daemon picked up …") means the
runtime is down or the trigger is off; the request is withdrawn so it can never fire later.
The cycle itself takes the review time (≤ `DISCORD_REVIEW_TIMEOUT_MS`) plus two Brain calls.

**Only depart after a real conversation.** The operator trigger needs just one transcript line,
but distillation must produce several usable shards. The first depart attempt consumes (and
destroys) the transcript; if a short conversation yields too few shards, the cycle retries twice
(~2.5 min) and then ends `abandoned` — the Wanderer re-arrives, but those lines are gone and no
memories were formed from them. Check `residency_cycle_*` logs after the cycle.
Equivalent without the CLI: `ghostc kill -s SIGUSR2 runtime` (tini forwards it).

Log events, in order: `residency_cycle_requested` → `residency_cycle_started` →
`residency_departed` (approved/rejected/candidates/journalPath) →
[`residency_commit_deferred_to_live_sweep`] → `door_hello` → `residency_live` →
[`residency_live_sweep_armed`] → `residency_cycle_complete` → `residency_cycle_outcome`
(`kind: cycled | abandoned | skipped | busy | aborted`); later, once candidates ripen,
`residency_live_commit_sweep` (committed / ripening / stranded counts). `skipped` = the transcript was empty
(nothing to distill); `busy` = a cycle was already running.

### 7.3 Automatic cycles (timer)

```bash
# ops/.env — e.g. one residency per day
NPC_RESIDENCY_MAX_MS=86400000
NPC_RESIDENCY_MIN_LINES=10
```

Checked every minute. Minimum `3600000` (1 h): every cycle costs a human review and Brain
calls. The timer waits (logging `residency_cycle_skipped` once) until the transcript holds
`NPC_RESIDENCY_MIN_LINES` lines — a near-silent residency cannot distill the 5 shards the
review requires. Someone must be around to review: unanswered shards are rejected.

### 7.4 Verify a cycle on the chain

Snapshot the volume ([§4.2](#42-snapshot-the-soulchain-volume-for-verification)), then:

```bash
DOOR_KEY="$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
node packages/osp-cli/dist/cli.js log ./_soulchain-snapshot --door-key="$DOOR_KEY"
node packages/osp-cli/dist/cli.js verify ./_soulchain-snapshot --door-key="$DOOR_KEY"
```

Expect, after the old residency's heartbeats: `memory/candidate` (one per ✅),
`memory/rejected` (per ❌ / timeout / screen category), `attestation/departure epoch=N`,
`attestation/travel from=… epoch=N`, then `attestation/arrival epoch=N+1` and its heartbeats;
with the commit sweep on, `memory/shard` × approved (residency `…/epoch:N`) appear among epoch
N+1's heartbeats once the window has passed; `verify` exits 0. Use the `=` form of
`--door-key` (base64url keys may start with `-`). `curl -sS http://127.0.0.1:8787/state`
returns `present` with the new epoch.

### 7.5 Commit sweep and Door review retention (read before enabling)

Promoting a candidate needs a Door co-signature over the commit envelope, and the Door only
co-signs for an epoch whose review it still holds. door-discord advertises `cosign.past_epochs`:
it keeps every completed review **per epoch** — not reset on arrival — for the last
`DOOR_COSIGN_RETAIN_EPOCHS` (default 16) reviewed epochs and at most `DOOR_COSIGN_RETAIN_MS`
(default 7 days), and persists it in `DOOR_STATE_DIR` (`/data/door-state`, named volume
`door-state` in Ghost compose) so a door-discord restart or upgrade keeps it. So the runtime
commits past epochs **while the next residency is live**:

```bash
# ops/.env — commit sweep on, production window
NPC_QUARANTINE_COMMIT_INTERVAL_MS=600000   # check every 10 min (≥ 10000)
NPC_QUARANTINE_WINDOW_MS=86400000          # default 24 h
```

```bash
ghostc up -d runtime door-discord
ghostc logs door-discord 2>&1 | grep door_cosign_retention   # durable: true, retainedEpochs
ghostc logs runtime 2>&1 | grep -E 'residency_lifecycle_config|residency_live_sweep_armed'
# residency_lifecycle_config … liveCommitSweep: true
```

- Commit requests for epoch *N* are signed with epoch *N*'s session key (re-derived from the
  soul key; nothing extra is stored). The Door still checks everything it did before: the
  shard was **approved** in epoch *N*'s review, the core is bound to epoch *N*'s residency and
  the reviewed text, one co-signature per chain position.
- **Upgrade in lockstep.** A runtime older than this change rejects a `hello` listing
  `cosign.past_epochs`; deploy runtime and door-discord from the same release.
- **Legacy Door** (no `cosign.past_epochs`): the runtime falls back to the old travel-gap sweep,
  and refuses to boot (`NPC_QUARANTINE_WINDOW_MS must be ≤ 3600000 …`, before any chain write)
  if the window is over 1 h while the sweep is on.
- **Stranded candidates.** A candidate whose review the Door no longer holds — evicted by the
  retention bound, reviewed before this change, an abandoned residency, or a door-discord
  restart **without** `DOOR_STATE_DIR` — gets `review_not_retained`; the runtime logs
  `quarantine_candidates_stranded_review_not_retained` once per process and stops asking. It
  stays `memory.candidate` (on chain, never composed, never on Atlas). Keep the retention
  bound well above the window (default 7 days vs 24 h).
- **Door state volume.** `door-state` holds, per retained epoch, the **approved** shard texts
  (rejected text is never written), the review's session public key and the commit
  co-signatures already issued — no secrets. Back it up only if you care about committing
  candidates after a host loss; deleting it strands candidates still ripening. If door-discord
  refuses to start with `invalid persisted cosign review state` (or a state file for another
  `door_id` after a guild change), move `cosign-state.json` aside — that strands ripening
  candidates, nothing else:

  ```bash
  ghostc run --rm --no-deps --entrypoint sh door-discord -c \
    'mv /data/door-state/cosign-state.json /data/door-state/cosign-state.json.bad'
  ```

- Fresh volume ownership: the image pre-creates `/data/door-state` as `npc` (uid 10001), same as
  the runtime volumes (§1.4). Smoke test:
  `ghostc run --rm --no-deps --entrypoint sh door-discord -c "touch /data/door-state/.w && rm /data/door-state/.w"`.
- There is no production path to flag a candidate during the window yet (`wanderer quarantine
  flag` is still test-only); the host review in Discord is the veto. The window is a delay,
  not a second review.
- With the sweep off (default) **journals never reach Atlas** — they exist only as files in
  `NPC_JOURNAL_DIR`, and candidates stay candidates.
