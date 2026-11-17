#!/usr/bin/env bash
# Host watchdog for the Ghost stack (T7.13).
#
# Dry-run is the default. The script prints one line per check and does not
# contact Discord, rclone, or the VPS. Probe files still get evaluated, so CI
# can prove alerts without a host.
#
# NPC_WATCHDOG_LIVE=1 is the only switch that pages Discord. That mode checks
# DISCORD_OPERATOR_WEBHOOK before any probe and exits 2 if it is missing or not
# an https Discord webhook URL (ops/SECRETS.md), even when every check would
# have been healthy. Live mode may run `ghostc ps`, `df -Pk /`, and read
# /proc/meminfo on this machine. It does not read ops/.env itself (live
# `ghostc ps` passes --env-file to docker compose), never calls rclone, and
# never copies a soulchain. Do not run under `bash -x`; the trace would show
# the webhook.
#
# Exit 0: no alerts. Exit 1: one or more alerts (or the Discord POST failed).
# Exit 2: bad arguments, or live paging was asked for but the webhook is missing
# or not a Discord URL. The webhook value is never printed.
#
# Probe environment (unset means "skip" in dry-run):
#   NPC_WATCHDOG_PS_FILE               lines of "<service> <health>", as from
#                                      docker compose ps --format '{{.Service}} {{.Health}}'
#   BACKUP_OK_PATH                     host-visible backup marker. The compose
#                                      marker lives inside the backup container;
#                                      do not point this at the host /tmp.
#   NPC_WATCHDOG_BACKUP_MTIME          injected marker mtime, for tests
#   NPC_WATCHDOG_NOW_EPOCH             injected clock (unix seconds), for tests
#   NPC_WATCHDOG_BACKUP_MAX_AGE_SEC    default 900 (compose health window)
#   NPC_WATCHDOG_LOCAL_CHAIN           path to a local chain.jsonl
#   NPC_WATCHDOG_LOCAL_CHAIN_EPOCH     injected local mtime, for tests
#   NPC_WATCHDOG_REMOTE_CHAIN_EPOCH    unix mtime of the remote chain.jsonl.
#                                      The caller supplies it. This script does
#                                      not talk to the backup remote (T7.13b).
#   NPC_WATCHDOG_CHAIN_SKEW_SEC        default 3600
#   NPC_WATCHDOG_DF_FILE               captured `df -Pk /` output
#   NPC_WATCHDOG_DISK_MIN_FREE_MB      default 2048
#   NPC_WATCHDOG_MEMINFO_FILE          captured /proc/meminfo
#   NPC_WATCHDOG_MEM_MIN_AVAILABLE_MB  default 256
#   DISCORD_OPERATOR_WEBHOOK           host-only webhook URL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$#" -gt 0 ]]; then
  echo "Usage: bash ops/scripts/watchdog.sh" >&2
  echo "[watchdog] ERROR: no arguments expected (configure with environment variables), got: $1" >&2
  exit 2
fi

# Step 1: live paging is opt-in. Any value other than 1 stays a dry-run.
live=0
if [[ "${NPC_WATCHDOG_LIVE:-}" == "1" ]]; then
  live=1
fi

if [[ "$live" -eq 1 ]]; then
  echo "[watchdog] mode=live"
else
  echo "[watchdog] mode=dry-run"
fi

# Decimal without leading zeros. "08" is rejected so bash does not treat it as
# octal and abort the script before the check can emit an ALERT.
is_decimal() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]
}

# https Discord webhook only. Shared by the live-mode gate and the POST.
webhook_is_valid() {
  local url="${DISCORD_OPERATOR_WEBHOOK:-}"
  [[ "$url" =~ ^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[^[:space:]]+$ ]]
}

# Step 1b: a bad live webhook must fail before probes, including a healthy run.
if [[ "$live" -eq 1 ]] && ! webhook_is_valid; then
  echo "[watchdog] ERROR: NPC_WATCHDOG_LIVE=1 but DISCORD_OPERATOR_WEBHOOK is unset or is not an https Discord webhook URL. Not posting." >&2
  exit 2
fi

alerts=0
alert_file="$(mktemp "${TMPDIR:-/tmp}/npc-watchdog.XXXXXX")"
# Newline-separated list so paths with spaces survive. The trap expands this
# when the shell exits, including ps_tmp created later.
temp_files="$alert_file"
# `|| true` keeps a cleanup failure from replacing the script's exit status.
# tmp_path is assigned by `read` when the trap runs; shellcheck does not see it.
# shellcheck disable=SC2154
trap 'printf "%s\n" "$temp_files" | while IFS= read -r tmp_path; do if [ -n "$tmp_path" ]; then rm -f "$tmp_path"; fi; done || true' EXIT

# Print a single operator line. ALERT lines are also queued for Discord.
report() {
  local level="$1"
  local check="$2"
  local consult="$3"
  local detail="$4"
  printf '%s %s | consult: %s | %s\n' "$level" "$check" "$consult" "$detail"
  if [[ "$level" == "ALERT" ]]; then
    printf '%s %s | consult: %s | %s\n' "$level" "$check" "$consult" "$detail" >>"$alert_file"
    alerts=$((alerts + 1))
  fi
}

# mtime of a regular file. GNU stat first, then BSD (macOS) stat.
file_mtime() {
  local path="$1"
  stat -c %Y "$path" 2>/dev/null || stat -f %m "$path"
}

# Step 2: container health. Dry-run reads NPC_WATCHDOG_PS_FILE only.
# Live mode asks ghostc, which skips preflight for `ps`.
check_containers() {
  local consult="ops/RUNBOOK.md#3-logs-and-health"
  local ps_file="${NPC_WATCHDOG_PS_FILE:-}"
  local ps_body=""
  if [[ -n "$ps_file" ]]; then
    if [[ ! -f "$ps_file" ]]; then
      report ALERT containers "$consult" "probe file missing (${ps_file}). Do not recreate volumes."
      return 0
    fi
    ps_body="$(cat "$ps_file")"
  elif [[ "$live" -eq 1 ]]; then
    local ghostc="${SCRIPT_DIR}/ghostc.sh"
    if [[ ! -f "$ghostc" ]]; then
      report ALERT containers "$consult" "ghostc.sh is missing. Do not recreate volumes."
      return 0
    fi
    if ! ps_body="$(bash "$ghostc" ps --format '{{.Service}} {{.Health}}' 2>&1)"; then
      report ALERT containers "$consult" "ghostc ps failed. Read runtime logs. Do not recreate volumes."
      return 0
    fi
  else
    report INFO containers "$consult" "skipped (dry-run). Set NPC_WATCHDOG_PS_FILE, or NPC_WATCHDOG_LIVE=1 to run ghostc ps. Fallback: ghostc ps."
    return 0
  fi

  # A file, not an unquoted heredoc: probe text must not be evaluated as shell.
  local ps_tmp
  ps_tmp="$(mktemp "${TMPDIR:-/tmp}/npc-watchdog-ps.XXXXXX")"
  temp_files="${temp_files}
${ps_tmp}"
  printf '%s\n' "$ps_body" >"$ps_tmp"
  local -a required
  required=(runtime door-discord door-web atlas-api backup)
  local name line found bad detail
  bad=0
  for name in "${required[@]}"; do
    found=0
    # Redirect, not a pipe, so `found` stays in this shell (bash 3.2 has no mapfile).
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      if [[ "$line" == "${name} healthy" ]]; then
        found=1
        break
      fi
    done <"$ps_tmp"
    if [[ "$found" -ne 1 ]]; then
      bad=$((bad + 1))
      if [[ "$name" == "backup" ]]; then
        detail="backup is missing or not healthy. Its healthcheck requires /tmp/backup.ok inside the container to be newer than 900s. Read backup logs. Do not delete the remote."
      else
        detail="${name} is missing or not healthy. Read logs for ${name}. Do not recreate volumes."
      fi
      report ALERT containers "$consult" "$detail"
    fi
  done
  rm -f "$ps_tmp"
  if [[ "$bad" -eq 0 ]]; then
    report OK containers "$consult" "runtime, door-discord, door-web, atlas-api, and backup are healthy. backup healthy also means the in-container marker is fresh."
  fi
}

# Step 3: backup marker freshness, only when a host-visible path is supplied.
# The default marker is inside the backup container; container health covers it.
check_backup() {
  local consult="ops/RUNBOOK.md#35-backup-activity"
  local path="${BACKUP_OK_PATH:-}"
  local max="${NPC_WATCHDOG_BACKUP_MAX_AGE_SEC:-900}"
  local now="${NPC_WATCHDOG_NOW_EPOCH:-}"
  if [[ -z "$now" ]]; then
    now="$(date +%s)"
  fi
  if ! is_decimal "$max" || ! is_decimal "$now"; then
    report ALERT backup_marker "$consult" "backup age settings are not integers. Do not delete the remote."
    return 0
  fi
  if [[ -z "$path" ]]; then
    report INFO backup_marker "$consult" "skipped. The compose marker is /tmp/backup.ok inside the backup container, covered by that service's healthcheck. Set BACKUP_OK_PATH only for a host-visible copy."
    return 0
  fi
  local mtime="${NPC_WATCHDOG_BACKUP_MTIME:-}"
  if [[ -z "$mtime" ]]; then
    if [[ ! -f "$path" ]]; then
      report ALERT backup_marker "$consult" "marker missing at ${path}. Read backup logs. Do not delete the remote."
      return 0
    fi
    mtime="$(file_mtime "$path" || true)"
  fi
  if ! is_decimal "$mtime"; then
    report ALERT backup_marker "$consult" "could not read the marker mtime. Do not delete the remote."
    return 0
  fi
  local age=$((now - mtime))
  if [[ "$age" -lt 0 ]]; then
    age=0
  fi
  if [[ "$age" -gt "$max" ]]; then
    report ALERT backup_marker "$consult" "marker age ${age}s exceeds ${max}s. Read backup logs. Do not delete the remote."
    return 0
  fi
  report OK backup_marker "$consult" "marker age ${age}s is within ${max}s."
}

# Step 4: local chain.jsonl mtime versus a caller-supplied remote mtime.
# No rclone here — sampling the backup remote is T7.13b.
check_chain() {
  local consult="ops/RUNBOOK.md#52-production-restore"
  local local_path="${NPC_WATCHDOG_LOCAL_CHAIN:-}"
  local remote_epoch="${NPC_WATCHDOG_REMOTE_CHAIN_EPOCH:-}"
  local skew="${NPC_WATCHDOG_CHAIN_SKEW_SEC:-3600}"
  if [[ -z "$local_path" || -z "$remote_epoch" ]]; then
    report INFO chain_mtime "$consult" "skipped. Set NPC_WATCHDOG_LOCAL_CHAIN and NPC_WATCHDOG_REMOTE_CHAIN_EPOCH. This script does not call rclone or copy the chain."
    return 0
  fi
  if ! is_decimal "$remote_epoch" || ! is_decimal "$skew"; then
    report ALERT chain_mtime "$consult" "remote epoch or skew is not an integer. Do not copy over either chain."
    return 0
  fi
  if [[ ! -f "$local_path" ]]; then
    report ALERT chain_mtime "$consult" "local chain.jsonl is missing. Do not copy over the remote."
    return 0
  fi
  local local_mtime="${NPC_WATCHDOG_LOCAL_CHAIN_EPOCH:-}"
  if [[ -z "$local_mtime" ]]; then
    local_mtime="$(file_mtime "$local_path" || true)"
  fi
  if ! is_decimal "$local_mtime"; then
    report ALERT chain_mtime "$consult" "could not read the local chain mtime. Do not copy over either chain."
    return 0
  fi
  local skew_abs=$((local_mtime - remote_epoch))
  if [[ "$skew_abs" -lt 0 ]]; then
    skew_abs=$((0 - skew_abs))
  fi
  if [[ "$skew_abs" -gt "$skew" ]]; then
    report ALERT chain_mtime "$consult" "local mtime ${local_mtime} and remote mtime ${remote_epoch} differ by ${skew_abs}s (limit ${skew}s). Verify before copying either side. Do not delete the remote."
    return 0
  fi
  report OK chain_mtime "$consult" "local and remote mtimes differ by ${skew_abs}s, within ${skew}s."
}

# Step 5: free space on /. Dry-run reads NPC_WATCHDOG_DF_FILE only.
check_disk() {
  local consult="ops/RUNBOOK.ghost.md#10-routine-operations"
  local df_file="${NPC_WATCHDOG_DF_FILE:-}"
  local min_mb="${NPC_WATCHDOG_DISK_MIN_FREE_MB:-2048}"
  local df_body=""
  if [[ -n "$df_file" ]]; then
    if [[ ! -f "$df_file" ]]; then
      report ALERT disk "$consult" "df probe file is missing. Do not delete volumes."
      return 0
    fi
    df_body="$(cat "$df_file")"
  elif [[ "$live" -eq 1 ]]; then
    if ! df_body="$(df -Pk / 2>&1)"; then
      report ALERT disk "$consult" "df failed. Do not delete volumes."
      return 0
    fi
  else
    report INFO disk "$consult" "skipped (dry-run). Set NPC_WATCHDOG_DF_FILE, or NPC_WATCHDOG_LIVE=1 to run df -Pk /."
    return 0
  fi
  if ! is_decimal "$min_mb"; then
    report ALERT disk "$consult" "disk floor is not an integer. Do not delete volumes."
    return 0
  fi
  local avail_kb
  avail_kb="$(printf '%s\n' "$df_body" | awk 'NR==2 { print $4 }')"
  if ! is_decimal "$avail_kb"; then
    report ALERT disk "$consult" "could not parse the df available-blocks column. Do not delete volumes."
    return 0
  fi
  local min_kb=$((min_mb * 1024))
  if [[ "$avail_kb" -lt "$min_kb" ]]; then
    report ALERT disk "$consult" "free space ${avail_kb} KiB is below ${min_mb} MiB. Prune old images only after the running tag is healthy. Do not delete volumes."
    return 0
  fi
  report OK disk "$consult" "free space ${avail_kb} KiB is at or above ${min_mb} MiB."
}

# Step 6: MemAvailable. Dry-run reads NPC_WATCHDOG_MEMINFO_FILE only.
check_memory() {
  local consult="ops/RUNBOOK.ghost.md#11-if-something-goes-wrong"
  local mem_file="${NPC_WATCHDOG_MEMINFO_FILE:-}"
  local min_mb="${NPC_WATCHDOG_MEM_MIN_AVAILABLE_MB:-256}"
  local mem_body=""
  if [[ -n "$mem_file" ]]; then
    if [[ ! -f "$mem_file" ]]; then
      report ALERT memory "$consult" "meminfo probe file is missing."
      return 0
    fi
    mem_body="$(cat "$mem_file")"
  elif [[ "$live" -eq 1 && -f /proc/meminfo ]]; then
    mem_body="$(cat /proc/meminfo)"
  else
    report INFO memory "$consult" "skipped. On the VPS, NPC_WATCHDOG_LIVE=1 reads /proc/meminfo. Elsewhere set NPC_WATCHDOG_MEMINFO_FILE."
    return 0
  fi
  if ! is_decimal "$min_mb"; then
    report ALERT memory "$consult" "memory floor is not an integer."
    return 0
  fi
  local avail_kb
  avail_kb="$(printf '%s\n' "$mem_body" | awk '/^MemAvailable:/ { print $2; found = 1 } END { if (!found) exit 1 }')" || avail_kb=""
  if ! is_decimal "$avail_kb"; then
    report ALERT memory "$consult" "MemAvailable is missing from meminfo. Do not raise mem_limit blindly."
    return 0
  fi
  local min_kb=$((min_mb * 1024))
  if [[ "$avail_kb" -lt "$min_kb" ]]; then
    report ALERT memory "$consult" "MemAvailable ${avail_kb} kB is below ${min_mb} MiB. See which service is at its mem_limit before changing limits."
    return 0
  fi
  report OK memory "$consult" "MemAvailable ${avail_kb} kB is at or above ${min_mb} MiB."
}

# Escape a Discord content string into a JSON string body. No jq.
json_content() {
  local text="$1"
  if [[ "${#text}" -gt 1800 ]]; then
    text="${text:0:1800}"
    text="${text}"$'\n'"truncated"
  fi
  local escaped="${text//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  escaped="${escaped//$'\t'/\\t}"
  escaped="${escaped//$'\r'/}"
  escaped="${escaped//$'\n'/\\n}"
  # Drop leftover ASCII controls so a probe path cannot break the JSON string.
  escaped="$(printf '%s' "$escaped" | tr -d '\000-\010\013\014\016-\037')"
  printf '{"content":"%s"}' "$escaped"
}

# Step 7: page Discord only for a real alert in live mode.
# Returns 0 when nothing was posted, 2 when live mode is misconfigured.
post_discord() {
  if [[ "$alerts" -eq 0 ]]; then
    echo "[watchdog] no alerts; Discord not contacted"
    return 0
  fi
  if [[ "$live" -ne 1 ]]; then
    echo "[watchdog] dry-run: Discord not contacted"
    return 0
  fi
  local url="${DISCORD_OPERATOR_WEBHOOK:-}"
  if ! webhook_is_valid; then
    echo "[watchdog] ERROR: NPC_WATCHDOG_LIVE=1 but DISCORD_OPERATOR_WEBHOOK is unset or is not an https Discord webhook URL. Not posting." >&2
    return 2
  fi
  local body
  body="$(json_content "$(cat "$alert_file")")"
  local err_file curl_rc url_cfg
  err_file="$(mktemp "${TMPDIR:-/tmp}/npc-watchdog-curl.XXXXXX")"
  temp_files="${temp_files}
${err_file}"
  # Keep the token out of argv. Quote/backslash in the URL are escaped so they
  # cannot break out of the curl config string.
  url_cfg="${url//\\/\\\\}"
  url_cfg="${url_cfg//\"/\\\"}"
  curl_rc=0
  # --proto rejects non-https. Stderr is discarded so a failed POST cannot echo the webhook.
  printf 'url = "%s"\n' "$url_cfg" | curl --proto "=https" --fail --silent --show-error --max-time 10 \
    -H "Content-Type: application/json" \
    -X POST \
    --data "$body" \
    -K - >/dev/null 2>"$err_file" || curl_rc=$?
  rm -f "$err_file"
  if [[ "$curl_rc" -ne 0 ]]; then
    echo "[watchdog] ERROR: Discord POST failed. The webhook URL was not logged." >&2
    return 1
  fi
  echo "[watchdog] live: posted ${alerts} alert(s) to Discord"
  return 0
}

check_containers
check_backup
check_chain
check_disk
check_memory

post_rc=0
post_discord || post_rc=$?
echo "[watchdog] alerts=${alerts}"
if [[ "$post_rc" -eq 2 ]]; then
  exit 2
fi
if [[ "$alerts" -gt 0 || "$post_rc" -ne 0 ]]; then
  exit 1
fi
exit 0
