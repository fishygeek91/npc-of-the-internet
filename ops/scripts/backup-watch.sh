#!/usr/bin/env bash
# Append-triggered soulchain backup via rclone.
# Watches BACKUP_SOURCE_DIR and debounces uploads to BACKUP_RCLONE_REMOTE.
#
# Durability contract (Bug #63):
#   - blobs/ are content-addressed and immutable → rclone copy (never sync/delete).
#   - chain.jsonl is append-only → refuse size regression unless ALLOW_CHAIN_SHRINK=1;
#     overwritten tips are preserved under remote/history/<UTC>-<pid>/ via --backup-dir.
#   - A successful sync touches BACKUP_OK_PATH (healthcheck consumer: issue #72).
set -euo pipefail

# Primary env (T6.1 spec); aliases match ops/compose.ghost.yml from Workstream A
BACKUP_SOURCE_DIR="${BACKUP_SOURCE_DIR:-${BACKUP_WATCH_PATH:-/data/soulchain}}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-${BACKUP_REMOTE:-}}"
BACKUP_DEBOUNCE_SEC="${BACKUP_DEBOUNCE_SEC:-5}"
BACKUP_INTERVAL_SEC="${BACKUP_INTERVAL_SEC:-300}"
RCLONE_CONFIG="${RCLONE_CONFIG:-${BACKUP_RCLONE_CONFIG:-}}"
ALLOW_CHAIN_SHRINK="${ALLOW_CHAIN_SHRINK:-}"
BACKUP_OK_PATH="${BACKUP_OK_PATH:-/tmp/backup.ok}"
BACKUP_ONCE="${BACKUP_ONCE:-}"

if [[ -z "$BACKUP_RCLONE_REMOTE" ]]; then
  echo "[backup-watch] ERROR: BACKUP_RCLONE_REMOTE is required (e.g. ghostbackup:soulchain)" >&2
  exit 1
fi

RCLONE_ARGS=()
if [[ -n "$RCLONE_CONFIG" ]]; then
  RCLONE_ARGS+=(--config "$RCLONE_CONFIG")
  export RCLONE_CONFIG
  if [[ ! -r "$RCLONE_CONFIG" ]]; then
    echo "[backup-watch] ERROR: cannot read rclone config at ${RCLONE_CONFIG} (permissions). Host path mounted at /config/rclone must be owned by uid/gid 10001 (container user npc) with mode allowing read (dir 0700, file 0600). See ops/RUNBOOK.ghost.md §5." >&2
    exit 1
  fi
fi

log() {
  echo "[backup-watch] $(date -u +"%Y-%m-%dT%H:%M:%SZ") $*"
}

stat_size() {
  local path="$1"
  if stat -c%s "$path" >/dev/null 2>&1; then
    stat -c%s "$path"
  else
    stat -f%z "$path"
  fi
}

stat_mtime() {
  local path="$1"
  if stat -c%Y "$path" >/dev/null 2>&1; then
    stat -c%Y "$path"
  else
    stat -f%m "$path"
  fi
}

# Bytes of remote chain.jsonl, or 0 if the object is absent.
# Returns 1 (no stdout size) on unknown rclone errors so callers refuse upload
# rather than treating a transient failure as "remote size 0" and bypassing the
# shrink guard. rclone exit 3/4 = not found → size 0.
remote_chain_size() {
  local remote_chain="$1"
  local json rc=0
  json="$(rclone lsjson "$remote_chain" "${RCLONE_ARGS[@]}" 2>/dev/null)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    # rclone: 3 = directory not found, 4 = file not found
    if [[ "$rc" -eq 3 || "$rc" -eq 4 ]]; then
      echo "0"
      return 0
    fi
    echo "[backup-watch] ERROR: rclone lsjson failed for ${remote_chain} (exit ${rc}); refusing to guess remote size" >&2
    return 1
  fi
  if [[ -z "$json" || "$json" == "[]" ]]; then
    echo "0"
    return 0
  fi
  # Prefer Size from the first JSON object; refuse on unparseable payload.
  local size
  size="$(printf "%s" "$json" | sed -n 's/.*"Size"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  if [[ -z "$size" ]]; then
    echo "[backup-watch] ERROR: could not parse Size from rclone lsjson for ${remote_chain}" >&2
    return 1
  fi
  echo "$size"
}

# Upload soulchain to remote. Returns 0 on success or benign skip; 1 on shrink refuse / rclone failure.
sync_backup() {
  local blobs_src="${BACKUP_SOURCE_DIR}/blobs"
  local chain_src="${BACKUP_SOURCE_DIR}/chain.jsonl"
  local remote="${BACKUP_RCLONE_REMOTE}"
  local remote_chain="${remote}/chain.jsonl"
  local local_size remote_size history_ts

  if [[ ! -d "$blobs_src" ]]; then
    log "WARN: blobs directory missing: $blobs_src"
    return 0
  fi
  if [[ ! -f "$chain_src" ]]; then
    log "WARN: chain.jsonl missing: $chain_src"
    return 0
  fi

  # Blobs are immutable CIDs — copy only; never delete remote orphans.
  log "Copying blobs/ → ${remote}/blobs/ (append-only; never deletes remote)"
  rclone copy "$blobs_src" "${remote}/blobs" "${RCLONE_ARGS[@]}"

  local_size="$(stat_size "$chain_src")"
  if ! remote_size="$(remote_chain_size "$remote_chain")"; then
    log "ERROR: could not determine remote chain.jsonl size; refusing upload (shrink guard cannot run safely)"
    return 1
  fi

  if (( local_size < remote_size )); then
    if [[ "$ALLOW_CHAIN_SHRINK" != "1" ]]; then
      log "ERROR: refusing to upload smaller chain.jsonl (local=${local_size} remote=${remote_size}); set ALLOW_CHAIN_SHRINK=1 to override"
      return 1
    fi
    log "WARN: ALLOW_CHAIN_SHRINK=1 — uploading smaller chain.jsonl (local=${local_size} remote=${remote_size}); previous tip moves to history/"
  fi

  # Preserve the prior tip under history/<UTC>-<pid>/ before overwriting the live tip.
  # Prefer BASHPID so debounce/periodic subshells get distinct suffixes within one second;
  # fall back to $$ for non-bash shells (cross-process uniqueness still holds).
  history_ts="$(date -u +"%Y%m%dT%H%M%SZ")-${BASHPID:-$$}"
  log "Copying chain.jsonl → ${remote_chain} (backup-dir history/${history_ts})"
  rclone copyto "$chain_src" "$remote_chain" \
    --backup-dir "${remote}/history/${history_ts}" \
    "${RCLONE_ARGS[@]}"

  touch "$BACKUP_OK_PATH"
  log "Sync complete (marker ${BACKUP_OK_PATH})"
}

DEBOUNCE_PID=""
DEBOUNCE_FLAG="/tmp/backup-watch-debounce-$$"

schedule_debounced_sync() {
  touch "$DEBOUNCE_FLAG"
  if [[ -n "$DEBOUNCE_PID" ]] && kill -0 "$DEBOUNCE_PID" 2>/dev/null; then
    return 0
  fi
  (
    while [[ -f "$DEBOUNCE_FLAG" ]]; do
      rm -f "$DEBOUNCE_FLAG"
      sleep "$BACKUP_DEBOUNCE_SEC"
      if [[ ! -f "$DEBOUNCE_FLAG" ]]; then
        sync_backup || log "WARN: debounced sync failed"
      fi
    done
  ) &
  DEBOUNCE_PID=$!
}

cleanup() {
  rm -f "$DEBOUNCE_FLAG"
  if [[ -n "${DEBOUNCE_PID:-}" ]] && kill -0 "$DEBOUNCE_PID" 2>/dev/null; then
    kill "$DEBOUNCE_PID" 2>/dev/null || true
    wait "$DEBOUNCE_PID" 2>/dev/null || true
  fi
  if [[ -n "${PERIODIC_PID:-}" ]] && kill -0 "$PERIODIC_PID" 2>/dev/null; then
    kill "$PERIODIC_PID" 2>/dev/null || true
    wait "$PERIODIC_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

blob_signature() {
  local blobs_dir="${BACKUP_SOURCE_DIR}/blobs"
  if [[ ! -d "$blobs_dir" ]]; then
    echo "missing"
    return 0
  fi
  local count size
  count="$(find "$blobs_dir" -type f 2>/dev/null | wc -l | tr -d ' ')"
  size="$(find "$blobs_dir" -type f -exec stat -c%s {} + 2>/dev/null | awk '{s+=$1} END {print s+0}' || \
          find "$blobs_dir" -type f -exec stat -f%z {} + 2>/dev/null | awk '{s+=$1} END {print s+0}')"
  echo "${count}:${size}"
}

log "Starting backup watch"
log "  source:   $BACKUP_SOURCE_DIR"
log "  remote:   $BACKUP_RCLONE_REMOTE"
log "  debounce: ${BACKUP_DEBOUNCE_SEC}s"
log "  interval: ${BACKUP_INTERVAL_SEC}s"
log "  ok path:  $BACKUP_OK_PATH"
if [[ "$BACKUP_ONCE" == "1" ]]; then
  log "  mode:     once (BACKUP_ONCE=1)"
  if sync_backup; then
    exit 0
  fi
  exit 1
fi

(
  while true; do
    sleep "$BACKUP_INTERVAL_SEC"
    log "Periodic safety sync (every ${BACKUP_INTERVAL_SEC}s)"
    sync_backup || log "WARN: periodic sync failed"
  done
) &
PERIODIC_PID=$!

sync_backup || log "WARN: initial sync failed"

if command -v inotifywait >/dev/null 2>&1; then
  log "Using inotifywait for change detection"
  while true; do
    inotifywait -r -e modify,create,close_write,move,delete \
      "$BACKUP_SOURCE_DIR" 2>/dev/null || sleep 2
    log "Change detected"
    schedule_debounced_sync
  done
else
  log "inotifywait not available; polling mtime/size of chain.jsonl + blobs/"
  last_chain_mtime=""
  last_chain_size=""
  last_blob_sig=""

  while true; do
    sleep 2
    chain_path="${BACKUP_SOURCE_DIR}/chain.jsonl"
    if [[ -f "$chain_path" ]]; then
      chain_mtime="$(stat_mtime "$chain_path")"
      chain_size="$(stat_size "$chain_path")"
      blob_sig="$(blob_signature)"
      if [[ "$chain_mtime" != "$last_chain_mtime" || "$chain_size" != "$last_chain_size" || "$blob_sig" != "$last_blob_sig" ]]; then
        if [[ -n "$last_chain_mtime" ]]; then
          log "Change detected (poll)"
          schedule_debounced_sync
        fi
        last_chain_mtime="$chain_mtime"
        last_chain_size="$chain_size"
        last_blob_sig="$blob_sig"
      fi
    fi
  done
fi
