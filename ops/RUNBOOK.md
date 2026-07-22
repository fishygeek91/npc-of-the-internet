# Ghost v0.1 — Operations Runbook

Single-VPS Docker Compose stack for the NPC of the Internet Ghost deployment. All commands assume the repository root as the current working directory unless noted.

## Architecture

Four services share one named Docker volume (`soulchain`):

| Service | Image | Role | Soulchain access |
|---------|-------|------|------------------|
| **runtime** | `ghcr.io/fishygeek91/npc-runtime` | Wanderer process (currently an **idle placeholder** until the Door HTTP/WS client and residency daemon land in [issue #53](https://github.com/fishygeek91/npc-of-the-internet/issues/53)) | read-write |
| **door-discord** | `ghcr.io/fishygeek91/npc-door-discord` | Discord Door relay; HTTP REST and WebSocket coalesced on port **9090** | none |
| **atlas-api** | `ghcr.io/fishygeek91/npc-atlas-api` | Read-only Atlas API on host port **8787** | read-only |
| **backup** | `ghcr.io/fishygeek91/npc-backup` | Append-triggered `rclone` sync to remote storage | read-only |

Host-mounted secrets (paths configured in `ops/.env`): soul private key, door private key, and `rclone.conf`. Only **runtime** writes to the soulchain volume. **atlas-api** and **backup** mount it read-only.

### Backup semantics

The backup sidecar (`ops/scripts/backup-watch.sh`) syncs in this order on each run:

1. `blobs/` → remote `blobs/` (`rclone sync`)
2. `chain.jsonl` → remote `chain.jsonl` (`rclone copyto`)

Blobs are uploaded before the chain file so a restore never references blob CIDs that have not yet reached the remote. After any restore, always run `osp verify` before starting the stack. If a crash left a torn trailing line or a stale `.append.lock`, recover with `FileSoulStore.openWithRecovery` (see [Crash recovery](#6-crash-recovery)) before verifying.

---

## 1. Start

### 1.1 Create environment file

```bash
cp ops/.env.example ops/.env
```

Edit `ops/.env` and replace every `replace-me` placeholder. At minimum you need valid `DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`, and production key material. See `ops/SECRETS.md` for variable names and purposes.

### 1.2 Create host key files and rclone config directory

Default paths from `ops/.env.example` (override with `SOUL_KEY_HOST_PATH`, `DOOR_KEY_HOST_PATH`, and `RCLONE_CONFIG_HOST_PATH` if you prefer different locations):

```bash
mkdir -p /tmp/npc-ghost/keys /tmp/npc-ghost/rclone

# Soul private key — 32 raw bytes or base64url text (mode 0600)
# Generate for production; for local smoke tests use any 32-byte file:
openssl rand -out /tmp/npc-ghost/keys/soul.key 32
chmod 600 /tmp/npc-ghost/keys/soul.key

# Door private key — same format
openssl rand -out /tmp/npc-ghost/keys/door.key 32
chmod 600 /tmp/npc-ghost/keys/door.key

# rclone remote config (credentials live here, never in the repo)
touch /tmp/npc-ghost/rclone/rclone.conf
chmod 600 /tmp/npc-ghost/rclone/rclone.conf
```

Set `SOUL_PUBLIC_KEY` in `ops/.env` to the base64url public key that matches `soul.key`. Set `ATLAS_DOOR_PUBKEYS` to the base64url public key that matches `door.key` (comma-separated if multiple doors).

Configure `BACKUP_RCLONE_REMOTE` to point at the remote defined in `rclone.conf` (for example `ghost-remote:npc/soulchain`).

### 1.3 Build and start the stack

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d --build
```

**Expected behavior after start:**

- **runtime** logs an idle-placeholder message and sleeps. It does not run a residency loop until [issue #53](https://github.com/fishygeek91/npc-of-the-internet/issues/53) ships.
- **door-discord** requires a real `DISCORD_BOT_TOKEN` and valid guild/channel IDs to stay healthy. Without them the container will crash-loop.
- **atlas-api** serves on `http://127.0.0.1:8787` once the soulchain volume contains a valid chain (empty volume returns errors until genesis).
- **backup** watches the soulchain volume and syncs to `BACKUP_RCLONE_REMOTE` when changes are detected.

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

### 3.3 Door coalesced HTTP + WebSocket

door-discord listens on a **single** port for both REST and WebSocket (`DOOR_HTTP_HOST` / `DOOR_HTTP_PORT`, default `0.0.0.0:9090` inside the container). Confirm both listeners in logs:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs door-discord 2>&1 | grep -E 'door_http_listening|door_ws_listening'
```

You should see `door_http_listening` and `door_ws_listening` both reporting port **9090**. The port is not published to the host in the default compose file; runtime reaches it on the internal Docker network.

### 3.4 Backup activity

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs backup 2>&1 | tail -20
```

Look for `Syncing blobs/` followed by `Syncing chain.jsonl` and `Sync complete`.

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

Pass door public keys from `ATLAS_DOOR_PUBKEYS` in `ops/.env` (comma-separated values become multiple `--door-key` flags):

```bash
node packages/osp-cli/dist/cli.js verify ./_soulchain-snapshot \
  --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
```

If you have multiple door keys, repeat `--door-key` for each (fixture keys shown as an example):

```bash
node packages/osp-cli/dist/cli.js verify ./_soulchain-snapshot \
  --door-key E5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8o \
  --door-key Q6cucUQBdi32a2jCbfvfJoKq7J8kdOykYT5CSg-6_Tw
```

Exit code `0` means the chain is valid. Exit code `1` means verification failed (printed rule failures). Exit code `2` means corruption or I/O error — see [Crash recovery](#6-crash-recovery) before proceeding.

### 4.4 Stop, pull or build, start

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml down
```

Pull published images (set `NPC_IMAGE_TAG` in `ops/.env` to match):

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml pull
```

Or build locally:

```bash
docker build -f ops/Dockerfile.runtime -t ghcr.io/fishygeek91/npc-runtime:local .
docker build -f ops/Dockerfile.door-discord -t ghcr.io/fishygeek91/npc-door-discord:local .
docker build -f ops/Dockerfile.atlas-api -t ghcr.io/fishygeek91/npc-atlas-api:local .
docker build -f ops/Dockerfile.backup -t ghcr.io/fishygeek91/npc-backup:local .
```

When using local tags, set `NPC_IMAGE_TAG=local` in `ops/.env`.

Start:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d --build
```

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

The repository ships a self-contained drill that needs no network. It seeds a fixture chain, simulates backup upload and restore via a local rclone remote, and runs `osp verify`:

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

Replace `/tmp/npc-ghost/rclone/rclone.conf` with your `RCLONE_CONFIG_HOST_PATH` if different. Substitute the remote name from `BACKUP_RCLONE_REMOTE` (for example `ghost-remote:npc/soulchain`).

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

1. **Stale `.append.lock`** — left when runtime crashed mid-append. `FileSoulStore.open` refuses to proceed while the lock exists.
2. **Torn trailing line in `chain.jsonl`** — a partial JSON line at the end of the file from a crash during write. The chain is incomplete and must be truncated to the last complete record.

There is no `osp recover` command. Recovery uses `FileSoulStore.openWithRecovery` from `@npc/osp-core`, which removes a stale lock, truncates a torn tail, and opens the store.

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

If `truncatedBytes > 0`, a torn tail was removed. If a stale lock was present, it is removed regardless.

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

**Operational note:** truncating a torn tail discards the incomplete record. That is correct crash-only semantics — the partial append never committed. After recovery, check backup remote freshness and consider a manual `rclone sync` if the remote may still hold the torn line (backup runs blobs-first, so a torn local tail may not yet have been uploaded).
