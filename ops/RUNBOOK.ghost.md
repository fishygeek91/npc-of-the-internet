# Ghost Deployment Runbook — Hetzner VPS

This is the complete, start-from-zero guide for deploying the npc-ghost Compose
stack (`ops/compose.ghost.yml`) to a Hetzner Cloud VPS. It assumes you have
never set up a server before. Follow it top to bottom; each step tells you
where you're typing (your Mac, or the server) and what you should see.

**Security posture (decided):** the server accepts **inbound SSH only**.
Atlas (`:8787`) is NOT open to the internet. You reach it via SSH tunnel from
your Mac. When Atlas goes public (Gate 2), we add a Cloudflare Tunnel —
outbound-only, no ports opened. Everything else the Ghost does (Discord,
Anthropic, rclone backups) is outbound and needs no open ports.

---

## 0. What you'll end up with

- A Hetzner **CX22** VPS (2 vCPU, 4 GB RAM, ~€4/mo) running Ubuntu 24.04
- A non-root user `ghost` that you log into with an SSH key (no passwords)
- A firewall (Hetzner Cloud Firewall + ufw) allowing only SSH
- Docker + Compose running the four Ghost containers from GHCR images
- Keys at `/var/lib/npc-ghost/keys/`, rclone config at `/var/lib/npc-ghost/rclone/`
- Automatic security updates, automatic container restarts on reboot
- Offsite soulchain backups via the backup sidecar (rclone → B2/R2)

Estimated time: 60–90 minutes.

---

## 1. On your Mac: create an SSH key

An SSH key is a pair of files: a private key (stays on your Mac, is the
secret) and a public key (goes on the server, is safe to share). It replaces
passwords entirely.

Open Terminal on your Mac and run:

```bash
ssh-keygen -t ed25519 -C "ghost-vps" -f ~/.ssh/ghost_vps
```

- When asked for a passphrase, set one (recommended) or press Enter twice for none.
- This creates `~/.ssh/ghost_vps` (private — never share, never commit) and
  `~/.ssh/ghost_vps.pub` (public).

Print the public key and copy the whole output line to your clipboard:

```bash
cat ~/.ssh/ghost_vps.pub
```

It looks like `ssh-ed25519 AAAA... ghost-vps`.

---

## 2. Create the Hetzner server

1. Sign up at https://console.hetzner.cloud (they may ask for ID or a small
   card verification — normal for them, anti-fraud).
2. Create a **New Project** (call it `npc-ghost`).
3. In the project, click **Add Server** and choose:
   - **Location:** Ashburn, VA (`ash`) — closest US region to you; Falkenstein
     (Germany) is fine too and slightly cheaper.
   - **Image:** Ubuntu 24.04
   - **Type:** Shared vCPU → x86 → **CX22** (2 vCPU / 4 GB / 40 GB).
     If CX22 isn't offered in your region, **CPX21** is the equivalent.
   - **Networking:** leave Public IPv4 + IPv6 checked.
   - **SSH keys:** click **Add SSH key**, paste the public key you copied in
     step 1, name it `macbook`. **Select it.** (This is what lets you in —
     don't skip it.)
   - Skip volumes, backups (Hetzner's paid snapshot backups are optional —
     the Ghost has its own backup sidecar), placement groups, cloud-init.
   - **Name:** `wanderer-1` (the box hosts the Wanderer across milestones;
     the *stack* it runs today is Ghost-shaped, but the server outlives v0.1)
4. Click **Create & Buy Now**. In ~30 seconds you'll see the server with a
   public IP like `5.161.x.x`. Note that IP — it's `YOUR_SERVER_IP` below.

### 2a. Hetzner Cloud Firewall (outer wall)

Still in the Hetzner console: **Firewalls → Create Firewall**.

- Name: `wanderer-fw`
- Inbound rules: **delete everything except** one rule:
  - TCP, port **22**, source `0.0.0.0/0` and `::/0` (SSH from anywhere).
- Outbound: leave unrestricted (Ghost needs outbound Discord/Anthropic/rclone).
- Apply to → select `wanderer-1`.

This filters traffic before it even reaches the server. We'll add ufw on the
server too — two walls, in case one is ever misconfigured.

---

## 3. First login and basic hardening

From your Mac:

```bash
ssh -i ~/.ssh/ghost_vps root@YOUR_SERVER_IP
```

Type `yes` when asked about the fingerprint (first-connection normal). You're
now root on the server. Everything in sections 3–7 is typed **on the server**.

### 3a. Update the OS

```bash
apt update && apt upgrade -y
```

If it mentions a new kernel, `reboot`, wait 30 seconds, and SSH back in.

### 3b. Create the `ghost` user (day-to-day user; root stays for emergencies)

```bash
adduser ghost          # invents a password when prompted — pick a strong one, save it in your password manager
usermod -aG sudo ghost # lets ghost run admin commands with sudo
```

Copy your SSH key to the new user so you can log in as `ghost` directly:

```bash
mkdir -p /home/ghost/.ssh
cp /root/.ssh/authorized_keys /home/ghost/.ssh/
chown -R ghost:ghost /home/ghost/.ssh
chmod 700 /home/ghost/.ssh && chmod 600 /home/ghost/.ssh/authorized_keys
```

### 3c. Lock down SSH (keys only, no root login)

```bash
nano /etc/ssh/sshd_config
```

(nano basics: arrow keys to move, edit text, then Ctrl+O Enter to save,
Ctrl+X to exit.)

Find and set these lines (remove any leading `#`):

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Ubuntu 24.04 also ships override files that can re-enable passwords; neutralize them:

```bash
rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf
systemctl restart ssh
```

**IMPORTANT — do not close this terminal yet.** Open a SECOND terminal on
your Mac and confirm you can still get in as ghost:

```bash
ssh -i ~/.ssh/ghost_vps ghost@YOUR_SERVER_IP
```

Only when that works, close the root session. If it doesn't work, fix it from
the still-open root session (or worst case, use the "Console" button in the
Hetzner web UI, which is a screen-and-keyboard into the machine).

### 3d. Make SSH-ing convenient (on your Mac)

Add this to `~/.ssh/config` on your **Mac** (create the file if it doesn't exist):

```
Host ghost
    HostName YOUR_SERVER_IP
    User ghost
    IdentityFile ~/.ssh/ghost_vps
```

Now `ssh ghost` is all you ever type.

### 3e. Server firewall (ufw — inner wall)

As `ghost` on the server (commands now use `sudo`):

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw enable        # answer y
sudo ufw status verbose
```

You should see: deny (incoming), allow (outgoing), 22/tcp ALLOW. Port 8787 is
NOT allowed — that's intentional.

### 3f. Fail2ban (bans IPs that spam SSH login attempts)

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

Defaults are fine for SSH.

### 3g. Automatic security updates

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # choose "Yes"
```

The server now patches itself. (Kernel updates still occasionally want a
reboot — see §9 maintenance.)

---

## 4. Install Docker

On the server, use Docker's official convenience script:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ghost
```

Log out and back in (`exit`, then `ssh ghost`) so the group change applies. Verify:

```bash
docker --version && docker compose version
```

Both should print versions without `sudo`.

---

## 5. Put the Ghost's files on the server

### 5a. Get the repo (for the compose file and ops scripts)

```bash
sudo apt install -y git
git clone https://github.com/fishygeek91/npc-of-the-internet.git ~/npc
cd ~/npc
```

You are NOT building images here — the compose file pulls prebuilt images
from GHCR (pushed by `.github/workflows/release.yml` on version tags).
If the GHCR packages are private, log in first:
create a GitHub token (github.com → Settings → Developer settings → Personal
access tokens → classic, scope `read:packages` only), then:

```bash
docker login ghcr.io -u fishygeek91    # paste the token as the password
```

If the packages are public, skip that.

### 5b. Create the persistent host directories

Per the compose file, keys and rclone config live on the host and are
bind-mounted read-only. **Never** use `/tmp` (wiped on reboot). Use:

```bash
sudo mkdir -p /var/lib/npc-ghost/keys /var/lib/npc-ghost/rclone
sudo chown -R ghost:ghost /var/lib/npc-ghost
chmod 700 /var/lib/npc-ghost
```

The parent `/var/lib/npc-ghost` can stay owned by `ghost:ghost` so you can
`scp` keys and manage files as the operator. The **bind-mounted subtrees**
`keys/` and `rclone/` must be owned by the container user instead — see below.

All Ghost images run as `npc` with uid **10001** and gid **10001**. Linux bind
mounts preserve host ownership: if `keys/` is `ghost:ghost`, runtime and
door-discord cannot read the mounted key files and will fail at startup. (Docker
Desktop on macOS remaps ownership, which masks this locally — on a Linux VPS it
is mandatory.)

### 5c. Copy the keys from your Mac

On your **Mac** (assuming your local `soul.key` / `door.key` exist — generate
them per the repo's ops/SECRETS.md if not):

```bash
scp /path/to/soul.key ghost:/var/lib/npc-ghost/keys/soul.key
scp /path/to/door.key ghost:/var/lib/npc-ghost/keys/door.key
```

Back on the server, hand ownership to the container user and restrict them:

```bash
sudo chown -R 10001:10001 /var/lib/npc-ghost/keys
chmod 700 /var/lib/npc-ghost/keys
chmod 600 /var/lib/npc-ghost/keys/*
```

**Encrypted offsite key backup (required):** configure `AGE_RECIPIENT` and a
**separate** rclone remote (`KEY_BACKUP_RCLONE_REMOTE`, different B2 app key /
bucket from the chain remote), then on the host (never in the backup sidecar):

```bash
bash ops/scripts/key-backup.sh
# Offline fixture proof (CI / first setup):
bash ops/scripts/key-backup-drill.sh
# Live verify against host keys + remote latest/ (needs AGE_IDENTITY_PATH):
NPC_KEY_DRILL_LIVE=1 bash ops/scripts/key-backup-drill.sh
```

Keep the age identity (`AGE_IDENTITY_PATH`) offline (USB / password manager),
never on the VPS alone. If `soul.key` is lost without a decryptable backup,
the being's identity is gone even if the chain restores.

**Rotating keys later:** once `keys/` is owned by `10001:10001` with mode
`0700`, `ghost` can no longer `scp` directly into that directory. To replace a
key, stage it in the home directory and move it in as root:

```bash
# On Mac:
scp /path/to/new-soul.key ghost:~/soul.key.new
# On server:
sudo mv ~/soul.key.new /var/lib/npc-ghost/keys/soul.key
sudo chown 10001:10001 /var/lib/npc-ghost/keys/soul.key
chmod 600 /var/lib/npc-ghost/keys/soul.key
```

Same pattern for `door.key`. Restart affected services after rotation
(`ghostc restart runtime` / `ghostc restart door-discord`).

### 5d. rclone config (offsite backups — do not skip)

The backup sidecar rclones the soulchain to a remote. Backblaze B2 free tier
(10 GB) is plenty. On the **server**:

```bash
sudo apt install -y rclone
rclone config
```

Walk-through for B2: `n` (new remote) → name it `ghost-remote` → storage type
`b2` → paste the keyID and applicationKey from your Backblaze account
(create a bucket, e.g. `npc-soulchain`, and an app key scoped to that bucket)
→ accept defaults → `q` to quit. Then put the config where compose expects it:

```bash
cp ~/.config/rclone/rclone.conf /var/lib/npc-ghost/rclone/rclone.conf
sudo chown -R 10001:10001 /var/lib/npc-ghost/rclone
chmod 700 /var/lib/npc-ghost/rclone
chmod 600 /var/lib/npc-ghost/rclone/rclone.conf
```

Or, if you copied keys and rclone config in one session:

```bash
sudo chown -R 10001:10001 /var/lib/npc-ghost/keys /var/lib/npc-ghost/rclone
chmod 700 /var/lib/npc-ghost/keys /var/lib/npc-ghost/rclone
chmod 600 /var/lib/npc-ghost/keys/* /var/lib/npc-ghost/rclone/rclone.conf
```

Test it:

```bash
rclone lsd ghost-remote:    # should list your bucket, no errors
```

`BACKUP_RCLONE_REMOTE` in .env will be `ghost-remote:npc/soulchain`
(remote-name:bucket/path). The sidecar uploads to this layout:

```
${BACKUP_RCLONE_REMOTE}/
  blobs/
  chain.jsonl
  history/<UTC>-<pid>/chain.jsonl
```

Upload uses `rclone copy` for blobs (never deletes remote orphans) and `rclone copyto` with `--backup-dir` for the chain tip. Prior tips land under `history/<UTC>-<pid>/`. **B2 bucket versioning is not required** — `history/` is the durability guarantee.

### 5e. Fill in the environment file

```bash
cd ~/npc
cp ops/.env.example ops/.env
chmod 600 ops/.env
nano ops/.env
```

Replace every placeholder. The important ones:

| Variable | Set to |
|---|---|
| `NPC_IMAGE_TAG` | the release tag you're deploying (e.g. `v0.1.0`) — pin a tag, avoid `latest` |
| `SOUL_KEY_HOST_PATH` | `/var/lib/npc-ghost/keys/soul.key` |
| `DOOR_KEY_HOST_PATH` | `/var/lib/npc-ghost/keys/door.key` |
| `RCLONE_CONFIG_HOST_PATH` | `/var/lib/npc-ghost/rclone` |
| `ANTHROPIC_API_KEY` | your real key — and set a **monthly spend limit** in the Anthropic console first |
| `DISCORD_BOT_TOKEN` / guild / channel / operator IDs | your real Discord values |
| `SOUL_PUBLIC_KEY` | the REAL soul public key — the .env.example value is a test fixture |
| `ATLAS_DOOR_PUBKEYS` | the REAL door public key(s) — same warning |
| `BACKUP_RCLONE_REMOTE` | `ghost-remote:npc/soulchain` |
| `AGE_RECIPIENT` / `KEY_BACKUP_RCLONE_REMOTE` | age pubkey + **separate** key-backup remote (never the chain remote) |

Sanity-check that compose can parse everything:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml config >/dev/null && echo OK
```

---

## 6. Keep Atlas off the public internet

Docker publishes ports by talking directly to the kernel, **bypassing ufw** —
a known Docker gotcha. The Hetzner Cloud Firewall (outer wall, §2a) still
blocks inbound traffic, but belt-and-suspenders: `ops/compose.ghost.yml`
publishes atlas-api as `127.0.0.1:8787:8787` so 8787 answers only on the
server itself — reachable by you via SSH tunnel, by nobody else. Public
exposure later is only ever via Cloudflare Tunnel (Gate 2, §8), never an
open port.

If an older VPS still has a hand-written `ops/compose.override.yml` that
only rebinds 8787 to localhost, you can delete it — the base file already
does that.

---

## 7. Launch

```bash
cd ~/npc
docker compose --env-file ops/.env -f ops/compose.ghost.yml pull
docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d
```

That's a lot to type; make an alias. Add to `~/.bashrc` on the server:

```bash
echo "alias ghostc='bash ~/npc/ops/scripts/ghostc.sh'" >> ~/.bashrc
source ~/.bashrc
```

`ghostc` runs `ops/scripts/preflight.sh` before mutating compose commands
(`up`, `restart`, …). Read-only helpers (`ps`, `logs`, `config`) skip preflight;
set `NPC_SKIP_PREFLIGHT=1` only when deliberately debugging a failed preflight.

From now on: `ghostc up -d`, `ghostc ps`, `ghostc logs -f runtime`, etc.

### 7a. Verify

```bash
ghostc ps
```

All four services should show `Up` (runtime waits for door-discord
`service_healthy` on `:9090`, then becomes `healthy` once its ready-file
exists; backup becomes `healthy` after the first successful sync touches
`/tmp/backup.ok`).

Confirm bind-mounted secrets are readable inside the containers (exit 0 =
readable; permission denied means host ownership is wrong — fix with
`sudo chown -R 10001:10001` on the affected host path):

```bash
ghostc exec runtime sh -c 'cat /run/keys/soul.key > /dev/null'
ghostc exec door-discord sh -c 'cat /run/keys/door.key > /dev/null'
ghostc exec backup sh -c 'test -r /config/rclone/rclone.conf'
```

```bash
ghostc logs -f runtime        # Ctrl+C to stop following
ghostc logs door-discord | tail -50
curl http://127.0.0.1:8787/   # atlas answers locally
```

Then the real test: talk to the Wanderer in your Discord channel.

### 7b. Verify from your Mac that nothing is exposed

On your **Mac**:

```bash
nc -zv -w 3 YOUR_SERVER_IP 22     # should succeed
nc -zv -w 3 YOUR_SERVER_IP 8787   # should TIME OUT / refuse — this is correct
```

To use Atlas from your Mac, open an SSH tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 ghost
```

Leave that running; `http://localhost:8787` in your Mac's browser is now the
server's Atlas. Ctrl+C to close the tunnel.

### 7c. Verify backups actually run

After the runtime has written something to the soulchain:

```bash
ghostc logs backup | tail -20
rclone ls ghost-remote:npc/soulchain
rclone ls ghost-remote:npc/soulchain/history
```

You should see `blobs/`, the live `chain.jsonl` tip, and archived tips under `history/<UTC>-<pid>/chain.jsonl`. Each successful chain overwrite adds a new `history/<UTC>-<pid>/` folder; **B2 bucket versioning is not required** for this guarantee.

**A backup you haven't seen restore is not a backup** — once, copy a file back down with `rclone copy` and eyeball it. For a full drill including anti-clobber proofs, run `bash ops/scripts/restore-drill.sh` on a workstation ([RUNBOOK §5.1](RUNBOOK.md#51-offline-restore-drill-development--ci)).

---

## 8. Going public later (Gate 2): Cloudflare Tunnel

When the Atlas site (GitHub Pages) needs to call the Atlas API publicly, do
NOT open 8787. Instead:

1. Get a domain (~$10/yr) and add it to a free Cloudflare account.
2. On the server: install `cloudflared`, `cloudflared tunnel login`, create a
   tunnel, route e.g. `atlas.yourdomain.com` → `http://127.0.0.1:8787`.
3. Run cloudflared as a systemd service (their docs have the one-liner).

The tunnel is an **outbound** connection from the server to Cloudflare — the
firewall stays exactly as it is, the server's IP stays hidden, Cloudflare
gives you HTTPS, caching, and rate limiting in front of Atlas. This can also
be added to compose as a fifth service later.

---

## 9. osp/0.2 cutover (required before Ghost runtime after #119)

Ghost runtime **only appends** `osp/0.2` records. Homogeneous `osp/0.1` chains
still verify and compose for read-only tools, but `Session.start` / quarantine
commit **refuse to start** with `SpecCutoverError` so the first new append cannot
poison the chain into a mixed-spec state.

If the VPS soulchain was initialized under `osp/0.1`, migrate **before** deploying
a runtime that writes `osp/0.2`:

```bash
# On the host (or a Mac with the chain dir + keys), with Door private keys for
# every Door that cosigned records on the chain:
pnpm --filter @npc/osp-cli exec node dist/cli.js migrate --to osp/0.2 /var/lib/npc-ghost/soulchain \
  --door-private-key "discord:YOUR_GUILD=<door-private-key-base64url>"
```

- The command rewrites the whole chain (extracts inline `text`/`journal` to side
  blobs, re-signs under the soul key + Door keys, rebuilds `prev` / evidence CIDs).
- Original directory is moved to `*.pre-osp-0.2-<timestamp>` beside the new chain.
- Record CIDs change — any bookmarks or published CIDs from the pre-migration
  chain do not survive (see `spec/osp/records.md` §Spec migration).
- Then `osp verify <dir> --door-key …` and restart the stack.

Fresh `osp init` already writes `osp/0.2` genesis — no migrate needed.

---

## 10. Routine operations

**Deploy a new release** (after CI pushes new images for tag `vX.Y.Z`):

```bash
nano ~/npc/ops/.env      # bump NPC_IMAGE_TAG=vX.Y.Z
ghostc pull && ghostc up -d
```

**Reboot safety:** `restart: unless-stopped` + Docker's systemd service means
everything comes back on its own after a reboot. Test it once: `sudo reboot`,
wait a minute, `ssh ghost`, `ghostc ps`.

**Check disk space** occasionally: `df -h /` and clean old images with
`docker image prune -af` after upgrades.

**Monthly:** `sudo apt update && sudo apt upgrade -y`, reboot if
`/var/run/reboot-required` exists.

**Monitoring on the cheap:** point a free uptime checker at Discord-side
behavior, or (post-Gate 2) at the tunnel URL. Until then,
`ghostc ps` when you think of it.

---

## 10a. IPFS replication (optional, Gate 2 for live push)

Ghost compose ships with **dual-write paths and Atlas CAR hooks disabled by default** — no outbound push until you explicitly enable replication.

**Safe local dual-write (no public push):** compose already mounts `/data/soulchain-ipfs` and `/data/published`. Runtime uses `DualSoulStore` when `NPC_SOULCHAIN_IPFS_DIR` is set. Leave `NPC_REPLICATION_ENABLED` unset.

**Enabling outbound replication (Gate 2):**

1. Obtain pinning-service tokens (Storacha, Filebase, or similar CAR-upload endpoint).
2. Add tokens to `ops/.env` per `ops/SECRETS.md` (`STORACHA_TOKEN`, `FILEBASE_TOKEN`, etc.).
3. Set `NPC_REPLICATION_ENABLED=1` and `NPC_REPLICATION_TARGETS` JSON array with at least two independent targets.
4. `ghostc up -d` and watch `ghostc logs runtime` for `replication_upload_ok` / `replication_upload_failed`.
5. Verify Atlas serves the CAR: `curl -s http://127.0.0.1:8787/soulchain/manifest` and download `/soulchain-latest.car` via SSH tunnel.

An **empty target list with `NPC_REPLICATION_ENABLED=1`** is valid — the drain runs as a no-op (useful for staging manifest/CAR publishing without push).

---

## 11. If something goes wrong

| Symptom | Likely cause / fix |
|---|---|
| Locked out of SSH | Hetzner console → server → "Console" button (web keyboard) |
| `runtime` restart-looping with `SpecCutoverError` / `soulchain is osp/0.1` | Chain still on `osp/0.1` — run §9 migrate before starting runtime |
| `runtime` restart-looping forever | `ghostc logs runtime` — usually bad key path, bad `SOUL_PUBLIC_KEY`, or door-discord failing first |
| `door-discord` up but bot offline in Discord | bad token, or bot not invited to the guild with the right intents |
| `backup` erroring | `rclone lsd ghost-remote:` on the host — if that fails, fix rclone.conf and `ghostc restart backup` |
| Anthropic errors in runtime logs | check API key, and check you haven't hit the spend cap you set (good problem: the cap worked) |
| `permission denied` on docker | you skipped the re-login after `usermod -aG docker` |

---

## Security summary (what you built)

- Inbound: SSH only, key-only auth, no root login, fail2ban, two firewalls
- Atlas bound to localhost; public exposure only ever via Cloudflare Tunnel
- Keys: `0600`, root-owned dir `0700`, age-encrypted remote key backup + offline age identity
- Secrets in `ops/.env` (`0600`), never committed
- OS patches itself; containers restart themselves
- Soulchain backed up offsite continuously by the backup sidecar
- Anthropic spend capped at the account level
