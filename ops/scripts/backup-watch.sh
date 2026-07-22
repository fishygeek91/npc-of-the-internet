#!/usr/bin/env bash
# Append-triggered soulchain backup via rclone.
# Watches BACKUP_SOURCE_DIR and debounces sync to BACKUP_RCLONE_REMOTE.
set -euo pipefail

# Primary env (T6.1 spec); aliases match ops/compose.ghost.yml from Workstream A
BACKUP_SOURCE_DIR="${BACKUP_SOURCE_DIR:-${BACKUP_WATCH_PATH:-/data/soulchain}}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-${BACKUP_REMOTE:-}}"
BACKUP_DEBOUNCE_SEC="${BACKUP_DEBOUNCE_SEC:-5}"
BACKUP_INTERVAL_SEC="${BACKUP_INTERVAL_SEC:-300}"
RCLONE_CONFIG="${RCLONE_CONFIG:-${BACKUP_RCLONE_CONFIG:-}}"

if [[ -z "$BACKUP_RCLONE_REMOTE" ]]; then
  echo "[backup-watch] ERROR: BACKUP_RCLONE_REMOTE is required (e.g. ghostbackup:soulchain)" >&2
  exit 1
fi

RCLONE_ARGS=()
if [[ -n "$RCLONE_CONFIG" ]]; then
  RCLONE_ARGS+=(--config "$RCLONE_CONFIG")
  export RCLONE_CONFIG
fi

log() {
  echo "[backup-watch] $(date -u +"%Y-%m-%dT%H:%M:%SZ") $*"
}

sync_backup() {
  local blobs_src="${BACKUP_SOURCE_DIR}/blobs"
  local chain_src="${BACKUP_SOURCE_DIR}/chain.jsonl"
  local remote="${BACKUP_RCLONE_REMOTE}"

  if [[ ! -d "$blobs_src" ]]; then
    log "WARN: blobs directory missing: $blobs_src"
    return 0
  fi
  if [[ ! -f "$chain_src" ]]; then
    log "WARN: chain.jsonl missing: $chain_src"
    return 0
  fi

  log "Syncing blobs/ → ${remote}/blobs/"
  rclone sync "$blobs_src" "${remote}/blobs" "${RCLONE_ARGS[@]}"

  log "Syncing chain.jsonl → ${remote}/chain.jsonl (copyto for last-write consistency)"
  rclone copyto "$chain_src" "${remote}/chain.jsonl" "${RCLONE_ARGS[@]}"

  log "Sync complete"
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

(
  while true; do
    sleep "$BACKUP_INTERVAL_SEC"
    log "Periodic safety sync (every ${BACKUP_INTERVAL_SEC}s)"
    sync_backup || log "WARN: periodic sync failed"
  done
) &
PERIODIC_PID=$!

log "Starting backup watch"
log "  source:   $BACKUP_SOURCE_DIR"
log "  remote:   $BACKUP_RCLONE_REMOTE"
log "  debounce: ${BACKUP_DEBOUNCE_SEC}s"
log "  interval: ${BACKUP_INTERVAL_SEC}s"

sync_backup

stat_mtime() {
  local path="$1"
  if stat -c%Y "$path" >/dev/null 2>&1; then
    stat -c%Y "$path"
  else
    stat -f%m "$path"
  fi
}

stat_size() {
  local path="$1"
  if stat -c%s "$path" >/dev/null 2>&1; then
    stat -c%s "$path"
  else
    stat -f%z "$path"
  fi
}

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
