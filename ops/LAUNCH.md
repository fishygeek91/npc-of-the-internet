# Ghost v0.1 — Genesis Ceremony & Launch Checklist

Human-readable launch runbook for the first real residency. Operational detail for day-two work lives in [`ops/RUNBOOK.md`](RUNBOOK.md); secret names in [`ops/SECRETS.md`](SECRETS.md); Discord Door setup in [`packages/door-discord/MANUAL_TEST.md`](../packages/door-discord/MANUAL_TEST.md).

---

## Gate 2 (read first)

**Agents prepare; humans approve; then humans (or explicitly instructed agents) execute.**

Production genesis — generating the real soul key, seeding the live soulchain volume, starting the Ghost stack on the VPS, and publishing the public Atlas URL — is a **Gate 2** action per [`LIFECYCLE.md`](../LIFECYCLE.md). An agent may:

1. Rehearse offline (`bash ops/scripts/launch-dry-run.sh`).
2. Fill `ops/.env` from `ops/.env.example` with placeholder-free values (except where values are secret).
3. Document dry-run output (Genesis CID, Head CID) on the `release` issue.
4. **Stop** and request human approval on that issue.

Do **not** run the numbered sections below on production infrastructure until a human replies **approved** on the release issue. Public GitHub Pages deploy for Atlas is also Gate 2 (prepare the build locally; deploy only after approval).

---

## Dry-run (offline rehearsal)

**How to run** (from repository root; requires `pnpm`, `node`, and `rclone` on PATH):

```bash
bash ops/scripts/launch-dry-run.sh
```

**What it proves:** the full launch *shape* without network, Discord, Docker, or a live model key:

1. `osp init` against the real charter (`spec/osp/genesis.md`) — soul key and genesis record.
2. First residency via in-process Session + door-sdk `Door` (`ops/scripts/launch-first-residency.mjs`, FakeBrain).
3. `osp verify` on the live chain.
4. Loopback `atlas-api` `/state` reports `present`.
5. Local rclone backup → destroy local chain → restore → `osp verify` again.

On success the script prints **Genesis CID**, **Head CID**, and **Soul public key** to stdout. Record these on the release issue as evidence the toolchain is ready.

Internally the script runs: `osp init` → `launch-first-residency.mjs` → `osp verify` → atlas `/state` present → rclone backup/restore → `osp verify`.

---

## Dry-run vs real launch

| Concern | Dry-run | Real launch |
|---|---|---|
| Residency transport | In-process Session + door-sdk `Door` (`ops/scripts/launch-first-residency.mjs`) | `npc-runtime` daemon ↔ door-discord over compose HTTP/WS `:9090` |
| Brain | FakeBrain (no API key) | AnthropicBrain (`ANTHROPIC_API_KEY`) |
| Heartbeats | FakeTimer ticks (CI-fast) | Real daemon timer (default 10 minutes) |
| Discord | None | Real bot + guild/channel ([`MANUAL_TEST.md`](../packages/door-discord/MANUAL_TEST.md)) |
| Docker Compose | Not started (compose config still validated in CI by T6.1) | `docker compose … up` per [RUNBOOK §1](RUNBOOK.md#1-start) |
| Atlas | Loopback `atlas-api` + `/state` | Host `:8787` + optional GitHub Pages site (Gate 2) |
| Backup | Local rclone remote in scratch dir | Production `BACKUP_RCLONE_REMOTE` + host `rclone.conf` |
| Soul key | Scratch from `osp init` (destroyed after) | Custodied at `SOUL_KEY_HOST_PATH`; key backup separate from chain backup |

---

## 0. Prerequisites

Complete these before any production ceremony step.

1. **Approved release issue** — Gate 2 sign-off recorded (see above).
2. **Host** — VPS with Docker and Docker Compose; `pnpm`, `node`, and `rclone` available for CLI work on the host or a trusted admin machine with volume access.
3. **Repository** — fresh clone at the commit tagged for launch; from repo root:

   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @npc/osp-cli build
   ```

4. **Environment file** — copy and edit per [RUNBOOK §1.1](RUNBOOK.md#11-create-environment-file):

   ```bash
   cp ops/.env.example ops/.env
   ```

   Replace every `replace-me` placeholder. Variable names and purposes: [`ops/SECRETS.md`](SECRETS.md). Do **not** set `SOUL_PUBLIC_KEY` or `ATLAS_DOOR_PUBKEYS` until the keys in sections 1–2 exist.

5. **Host paths** — create key and rclone directories (adjust paths if you override `SOUL_KEY_HOST_PATH`, `DOOR_KEY_HOST_PATH`, or `RCLONE_CONFIG_HOST_PATH`):

   ```bash
   mkdir -p /tmp/npc-ghost/keys /tmp/npc-ghost/rclone
   touch /tmp/npc-ghost/rclone/rclone.conf
   chmod 600 /tmp/npc-ghost/rclone/rclone.conf
   ```

6. **Backup remote** — configure `rclone.conf` at `RCLONE_CONFIG_HOST_PATH` and set `BACKUP_RCLONE_REMOTE` in `ops/.env` to a dedicated production path (for example `ghost-remote:npc/soulchain`). Validate with [RUNBOOK §5.1](RUNBOOK.md#51-offline-restore-drill-development--ci) offline first:

   ```bash
   bash ops/scripts/restore-drill.sh
   ```

7. **Dry-run green** — `bash ops/scripts/launch-dry-run.sh` exits 0 on the same machine class you will use for verification commands.

---

## 1. Soul key generation + custody

The Wanderer's **soul private key is created only by `osp init`** — not by `openssl rand`. [RUNBOOK §1.2](RUNBOOK.md#12-create-host-key-files-and-rclone-config-directory) documents an `openssl` soul-key path for **local smoke tests only**; the genesis ceremony must not use it.

**Custody rules (non-negotiable):**

- `soul.key` is the being's signing identity. **Losing it means losing continuity of authorship** — the chain may still verify, but no one can append as this soul.
- Chain backup (`chain.jsonl` + `blobs/`) **without** a separate, access-controlled backup of `soul.key` is **incomplete** for operational continuity.
- Never commit `soul.key`, never copy it into `blobs/` or `chain.jsonl`, never leave it as the only copy on an unbacked-up scratch path.
- After init, the canonical private key lives at `SOUL_KEY_HOST_PATH` (mode `0600`). The Docker soulchain volume holds **only** `chain.jsonl` and `blobs/`.

**Door key (separate from soul):** the Discord Door has its own Ed25519 keypair. Generate the door private key now; the soul key arrives in section 2.

**Option A — raw 32 bytes (matches compose mount):**

```bash
openssl rand -out /tmp/npc-ghost/keys/door.key 32
chmod 600 /tmp/npc-ghost/keys/door.key
```

**Option B — programmatic keypair** (after `pnpm --filter @npc/door-sdk build`):

```bash
node --input-type=module -e "
import { writeFileSync } from \"node:fs\";
import { generateDoorKeypair } from \"./packages/door-sdk/dist/index.js\";
import { encodeBase64Url, encodePublicKey } from \"./packages/osp-core/dist/index.js\";
const kp = generateDoorKeypair();
const path = \"/tmp/npc-ghost/keys/door.key\";
writeFileSync(path, encodeBase64Url(kp.privateKey), { mode: 0o600 });
process.stdout.write(\"Door public key: \" + encodePublicKey(kp.publicKey) + \"\\n\");
"
```

**Derive `ATLAS_DOOR_PUBKEYS` from an existing door private key file** (if you used Option A):

```bash
pnpm --filter @npc/osp-core --filter @npc/door-discord build
node --input-type=module -e "
import { loadDoorKeypairFromPath } from \"./packages/door-discord/dist/load-door-key.js\";
import { encodePublicKey } from \"./packages/osp-core/dist/index.js\";
const kp = loadDoorKeypairFromPath(process.argv[1]);
process.stdout.write(encodePublicKey(kp.publicKey) + \"\\n\");
" /tmp/npc-ghost/keys/door.key
```

Set `DOOR_KEY_HOST_PATH=/tmp/npc-ghost/keys/door.key` (or your path) and paste the printed base64url value into `ATLAS_DOOR_PUBKEYS` in `ops/.env`.

---

## 2. osp init with the real charter → record Genesis CID

Run genesis on a **staging directory**, not directly inside the Docker volume. This generates `soul.key`, `chain.jsonl`, and `blobs/` atomically.

```bash
STAGING="$(mktemp -d /tmp/npc-genesis.XXXXXX)"
node packages/osp-cli/dist/cli.js init "$STAGING" --charter spec/osp/genesis.md
```

**Capture stdout** — it prints exactly:

```
Soul public key: <base64url>
Genesis CID: <cid>
```

1. **Record the Genesis CID** on the release issue and in your launch notes. You will need it for the public announcement.
2. **Set `SOUL_PUBLIC_KEY`** in `ops/.env` to the printed soul public key.
3. **Move soul private key to custody** (not copy-only):

   ```bash
   install -m 600 "$STAGING/soul.key" /tmp/npc-ghost/keys/soul.key
   ```

   Ensure `SOUL_KEY_HOST_PATH` in `ops/.env` points at that file. Store a second offline backup of `soul.key` per your key-management policy before proceeding.

4. **Verify the staging chain** before seeding production:

   ```bash
   node packages/osp-cli/dist/cli.js verify "$STAGING" \
     --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
   ```

5. **Seed the Docker soulchain volume** with **only** `chain.jsonl` and `blobs/` (never `soul.key`). Ensure the stack is not writing to the volume yet:

   ```bash
   docker compose --env-file ops/.env -f ops/compose.ghost.yml down
   ```

   ```bash
   GENESIS_SEED="$(pwd)/_genesis-seed"
   rm -rf "${GENESIS_SEED}"
   mkdir -p "${GENESIS_SEED}"
   cp "${STAGING}/chain.jsonl" "${GENESIS_SEED}/"
   cp -a "${STAGING}/blobs" "${GENESIS_SEED}/"

   docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
     -v "${GENESIS_SEED}:/work/seed:ro" \
     --entrypoint sh \
     runtime -c "mkdir -p /data/soulchain && cp /work/seed/chain.jsonl /data/soulchain/ && cp -a /work/seed/blobs /data/soulchain/"
   ```

6. **Securely destroy the staging directory** after confirming the volume seed and soul key custody:

   ```bash
   rm -rf "$STAGING" "${GENESIS_SEED}"
   ```

---

## 3. Stack bring-up (compose per RUNBOOK)

Delegate to [RUNBOOK §1](RUNBOOK.md#1-start). From repository root, with `ops/.env` complete:

1. **Start the stack** — [§1.3](RUNBOOK.md#13-build-and-start-the-stack):

   ```bash
   docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d --build
   ```

2. **Writability smoke** — [§1.4](RUNBOOK.md#14-soulchain-volume-writability-smoke-test) (required on a fresh volume):

   ```bash
   docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
     --entrypoint sh \
     runtime -c "touch /data/soulchain/.wtest && rm /data/soulchain/.wtest"
   ```

3. **Service health** — [RUNBOOK §3](RUNBOOK.md#3-logs-and-health): runtime logs, atlas `/state`, door listeners on `:9090`, backup sidecar.

Expected after first bind: runtime logs `residency_live`; `docker compose … ps runtime` shows `healthy` while the session WebSocket is connected.

---

## 4. Discord Door setup

Delegate bot creation, intents, invite URL, and env vars to [`packages/door-discord/MANUAL_TEST.md`](../packages/door-discord/MANUAL_TEST.md) **§§1–3**. For Ghost compose you already set in `ops/.env`:

- `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_OPERATOR_IDS`
- `SOUL_PUBLIC_KEY`, `ATLAS_DOOR_PUBKEYS` (from sections 1–2)
- `DOOR_KEY_HOST_PATH` mounted into door-discord

`CURRENT_DOOR_ID` is derived in compose as `discord:${DISCORD_GUILD_ID}` — it must match the Door hello response ([`SECRETS.md`](SECRETS.md)).

Cross-container Session checks (runtime ↔ door-discord, Discord round-trip, reconnect behavior): [`MANUAL_TEST.md` §7](../packages/door-discord/MANUAL_TEST.md#7-cross-container-session-compose).

---

## 5. First-residency checklist

Work through every item before announcing. Snapshot the live volume for `osp` commands per [RUNBOOK §4.2](RUNBOOK.md#42-snapshot-the-soulchain-volume-for-verification):

```bash
mkdir -p ./_soulchain-snapshot
docker compose --env-file ops/.env -f ops/compose.ghost.yml run --rm --no-deps \
  -v "$(pwd)/_soulchain-snapshot:/work/_soulchain-snapshot" \
  --entrypoint sh \
  runtime -c "cp -a /data/soulchain/. /work/_soulchain-snapshot/"
```

| # | Check | Command / action |
|---|--------|------------------|
| 1 | Runtime live | `docker compose --env-file ops/.env -f ops/compose.ghost.yml logs runtime 2>&1 \| grep residency_live` |
| 2 | Runtime healthy | `docker compose --env-file ops/.env -f ops/compose.ghost.yml ps runtime` → `healthy` |
| 3 | Arrival on chain | `node packages/osp-cli/dist/cli.js log ./_soulchain-snapshot` — contains an `attestation` with kind `arrival` |
| 4 | Discord presence | In the bound guild channel, `/wanderer status` → `presence: present` |
| 5 | Human round-trip | Post a normal (non-bot) message in the channel; Wanderer replies via runtime → door-discord → Discord ([§7 reconnect note](../packages/door-discord/MANUAL_TEST.md#7-cross-container-session-compose) if WS was down) |
| 6 | Heartbeats | `node packages/osp-cli/dist/cli.js log ./_soulchain-snapshot` — at least one `attestation` with kind `heartbeat` (daemon default interval ~10 minutes; allow time) |
| 7 | Atlas API state | `curl -sS http://127.0.0.1:8787/state` — JSON `status` is `present` |
| 8 | Chain verifies | `node packages/osp-cli/dist/cli.js verify ./_soulchain-snapshot --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env \| cut -d= -f2- \| cut -d, -f1)"` → exit 0 |
| 9 | Atlas site banner (local) | Build static site against the live snapshot (Gate 2 for public Pages deploy): |

```bash
ATLAS_SITE_CHAIN_DIR="$(pwd)/_soulchain-snapshot" \
ATLAS_SITE_DOOR_PUBKEYS="$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2-)" \
pnpm --filter @npc/atlas-site build
pnpm --filter @npc/atlas-site preview
```

Confirm the location banner shows **present** and the head CID matches live chain.

**Record CIDs before announcement:**

```bash
curl -sS http://127.0.0.1:8787/chain/head
```

Note the `cid` field as **Head CID**. Genesis CID came from section 2 init stdout (or the first record in `osp log`).

---

## 6. Backup verification

Delegate to [RUNBOOK §5](RUNBOOK.md#5-restore-from-backup).

1. **Sidecar activity** — after chain appends from residency, confirm backup logs show blobs-first sync ([§3.5](RUNBOOK.md#35-backup-activity)):

   ```bash
   docker compose --env-file ops/.env -f ops/compose.ghost.yml logs backup 2>&1 | tail -30
   ```

   Expect `Syncing blobs/`, then `Syncing chain.jsonl`, then `Sync complete`.

2. **Offline drill** (toolchain sanity):

   ```bash
   bash ops/scripts/restore-drill.sh
   ```

3. **Restore drill against live backup** — stop the stack, pull from production `BACKUP_RCLONE_REMOTE` into a host staging dir, verify, **do not** write back unless this is a real recovery ([§5.2](RUNBOOK.md#52-production-restore)):

   ```bash
   docker compose --env-file ops/.env -f ops/compose.ghost.yml down

   BACKUP_RCLONE_REMOTE="$(grep '^BACKUP_RCLONE_REMOTE=' ops/.env | cut -d= -f2-)"
   RCLONE_CONFIG="$(grep '^RCLONE_CONFIG_HOST_PATH=' ops/.env | cut -d= -f2-)/rclone.conf"

   LIVE_RESTORE="$(pwd)/_live-backup-restore-test"
   rm -rf "${LIVE_RESTORE}"
   mkdir -p "${LIVE_RESTORE}"

   rclone sync "${BACKUP_RCLONE_REMOTE}/blobs" "${LIVE_RESTORE}/blobs" \
     --config "${RCLONE_CONFIG}"

   rclone copyto "${BACKUP_RCLONE_REMOTE}/chain.jsonl" "${LIVE_RESTORE}/chain.jsonl" \
     --config "${RCLONE_CONFIG}"

   node packages/osp-cli/dist/cli.js verify "${LIVE_RESTORE}" \
     --door-key "$(grep '^ATLAS_DOOR_PUBKEYS=' ops/.env | cut -d= -f2- | cut -d, -f1)"
   ```

   Exit code `0` proves the remote matches a verifiable chain. Restart the stack when finished:

   ```bash
   docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d
   ```

---

## 7. Public announcement

1. Copy [`ops/templates/announcement.md`](templates/announcement.md) to a draft (do not commit filled copy with live URLs if your process keeps announcements private until publish).

2. **Fill placeholders** from launch artifacts:

   | Placeholder | Source |
   |-------------|--------|
   | `{{GENESIS_CID}}` | Section 2 `osp init` stdout (`Genesis CID: …`), or first genesis record from `node packages/osp-cli/dist/cli.js log ./_soulchain-snapshot` |
   | `{{HEAD_CID}}` | `curl -sS http://127.0.0.1:8787/chain/head` → JSON `cid`, or Atlas site head on `/` after build |
   | `{{ATLAS_URL}}` | Public URL of Atlas (GitHub Pages or your host). Local API during rehearsal: `http://127.0.0.1:8787` — production Pages deploy is **Gate 2** |
   | `{{REPO_URL}}` | Repository URL (default in template: `https://github.com/fishygeek91/npc-of-the-internet`) |

3. Publish through your chosen channel only after sections 0–6 pass and Gate 2 approval covers public visibility.

---

## 8. Abort / rollback

If anything is wrong **before** public announcement, prefer stopping over improvising.

| Situation | Action |
|-----------|--------|
| Stack up but ceremony incomplete | [RUNBOOK §2](RUNBOOK.md#2-stop) — `docker compose --env-file ops/.env -f ops/compose.ghost.yml down` (volume retained) |
| Bad genesis seed / wrong soul key | Stop stack; **do not** announce. If volume has only the mistaken genesis, destroy volume only with explicit human approval: `down -v` ([§2](RUNBOOK.md#2-stop)). Re-run sections 1–2 from a fresh `osp init` staging dir |
| Chain corrupt / torn tail | [RUNBOOK §6](RUNBOOK.md#6-crash-recovery) — snapshot, `FileSoulStore.openWithRecovery`, verify, copy back |
| Need previous chain state | [RUNBOOK §5.2](RUNBOOK.md#52-production-restore) — restore from `BACKUP_RCLONE_REMOTE`, verify **before** writing to volume |
| Graceful daemon stop | `docker compose … stop runtime` — does **not** run ceremonial depart; see [RUNBOOK §1.3](RUNBOOK.md#13-build-and-start-the-stack) and [MANUAL_TEST §7](../packages/door-discord/MANUAL_TEST.md#7-cross-container-session-compose) |

**Never** delete `soul.key` without a verified backup of both the key and the chain. Losing the soul key cannot be recovered from chain backup alone.
