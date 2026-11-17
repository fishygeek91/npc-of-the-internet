# AI operator

An agent runs the Ghost stack from the scripts named here. If a script is not
listed, do not invent the shell commands — stop and point at the follow-up
task. Gate 2 stays a human.

This file is the map. Day-two detail stays in [`RUNBOOK.md`](RUNBOOK.md), host
setup in [`RUNBOOK.ghost.md`](RUNBOOK.ghost.md), first boot in
[`LAUNCH.md`](LAUNCH.md), and secret **names** in [`SECRETS.md`](SECRETS.md).

## Gate 2 — a human approves before anyone executes

From [`LIFECYCLE.md`](../LIFECYCLE.md) §8, plus the consoles this repo cannot
script. A human writes "approved" on the release issue. The flag on a script
is not that approval.

- Deploying the runtime or Doors onto the VPS, including `ghostc pull` / `ghostc up -d` for a release
- Genesis, and generating or rotating the soul key or door key
- Wallet or treasury operations
- Tagging a release or publishing images (that is `release.yml`; do not push a tag to force it)
- Atlas at a public URL, including GitHub Pages
- Turning on outbound IPFS replication
- Hetzner, Backblaze, Discord, and model-provider account or billing consoles
- Offline soul-key custody
- Applying host provisioning (new VPS, sshd, ufw, fail2ban)
- Installing a host cron or systemd timer, including the watchdog example below

## What an agent can run with no Gate 2 flag

| Command | What the default does |
| --- | --- |
| `bash ops/scripts/watchdog.sh` | Prints checks. No Discord, no Docker, no rclone. |
| `bash ops/scripts/restore-drill.sh` | Offline fixture backup, restore, and `osp verify`. |
| `bash ops/scripts/launch-dry-run.sh` | Offline launch rehearsal (throwaway keys in a temp dir). |
| `bash ops/scripts/key-backup-drill.sh` | Offline age drill. `NPC_KEY_DRILL_LIVE=1` is a separate, explicit mode. |
| `bash ops/scripts/preflight.sh` | Read-only host checks. `ghostc` runs it before `up` / `pull`. |
| `bash ops/scripts/backup-watch-budget-test.sh` | CI regression for backup Class C calls. |
| `bash ops/scripts/image-cmd-smoke.sh` | CI check that image CMDs are not the `.bin` trap. |
| `bash ops/scripts/uid-mount-check.sh` | CI check for the container uid/gid. |

`ghostc up` and `ghostc pull` start or update the local compose project. On a
VPS that **is** a deploy. Do not run them there without Gate 2 approval.
Scripted deploy with rollback is not in this tree yet ([#182](https://github.com/fishygeek91/npc-of-the-internet/issues/182)).

## Watchdog

```bash
bash ops/scripts/watchdog.sh
```

Each line is `OK`, `INFO`, or `ALERT`, then the check name, then `consult:`
and a runbook anchor an agent can open. Alerts say what not to do (do not
delete the remote, do not recreate volumes).

`NPC_WATCHDOG_LIVE=1` is the only value that changes this. It runs `ghostc ps`,
`df -Pk /`, and, on Linux, reads `/proc/meminfo`. If any check is `ALERT` and
`DISCORD_OPERATOR_WEBHOOK` is `https://discord.com/api/webhooks/…` (or
`discordapp.com`), it POSTs the alert lines. A healthy live run does not post.
Any other URL is refused and not contacted. The URL is never printed.

The backup marker in compose is `/tmp/backup.ok` **inside** the backup
container. `backup healthy` from `ghostc ps` already means that marker is
younger than 900s. Set `BACKUP_OK_PATH` only when the marker is visible on the
host. Remote `chain.jsonl` mtime is compared only when the caller passes
`NPC_WATCHDOG_REMOTE_CHAIN_EPOCH`; this script does not call rclone.

Do not install a timer as part of reading this file. Example, not applied:

```bash
# NOT INSTALLED. A human approves operator alerting before this exists on a host.
# */10 * * * * cd "$HOME/npc" && NPC_WATCHDOG_LIVE=1 bash ops/scripts/watchdog.sh
```

## Scheduled drill

[`.github/workflows/ops-drill.yml`](../.github/workflows/ops-drill.yml) runs
`restore-drill.sh` at 16:00 UTC on the 1st, on a GitHub-hosted runner.
`workflow_dispatch` runs the same job. It has no secrets and does not pull the
production backup. If the drill fails, the workflow opens or comments on a
GitHub issue titled `[ops] offline restore drill failed`.

Pulling `BACKUP_RCLONE_REMOTE` into a staging directory is a host action and
is not this workflow ([#182](https://github.com/fishygeek91/npc-of-the-internet/issues/182)).

## Not scripted yet

Do not improvise these. The manual runbook is the fallback only after a human
approval, and the scripted form is the follow-up:

| Still manual | Follow-up |
| --- | --- |
| Deploy with snapshot, verify, and rollback (RUNBOOK §4) | #182 T7.13b |
| Scheduled `osp verify` of a volume snapshot (RUNBOOK §4.2–4.3) | #182 T7.13b |
| Monthly pull of the production backup (LAUNCH §6 / RUNBOOK §5.2) | #182 T7.13b |
| cloud-init / `provision.sh` for RUNBOOK.ghost §§2–4 | #182 T7.13b |
| Supplying the remote chain mtime to the watchdog | #182 T7.13b |
| `gen-door-key.sh`, `genesis.sh` (LAUNCH §1–2) | #183 T7.13c |
| First-residency report, checks 1–3 and 6–8 (LAUNCH §5) | #183 T7.13c |
| Announcement placeholder fill (LAUNCH §7) | #183 T7.13c |

Discord presence and the human round-trip (LAUNCH §5 checks 4 and 5) stay
human even after #183.
