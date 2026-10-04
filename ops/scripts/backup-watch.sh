#!/usr/bin/env bash
# Append-triggered soulchain backup via rclone.
# Watches BACKUP_SOURCE_DIR and debounces uploads to BACKUP_RCLONE_REMOTE.
#
# Durability contract (Bug #63):
#   - blobs/ are content-addressed and immutable → rclone copy (never sync/delete).
#   - chain.jsonl is append-only → refuse size regression unless ALLOW_CHAIN_SHRINK=1;
#     overwritten tips are preserved under remote/history/<UTC>-<pid>/ via --backup-dir.
#   - Blobs reach the remote before the chain tip that references them: the chain
#     is snapshotted before blobs/ is copied, the snapshot is what gets uploaded,
#     and a failed blob copy aborts the cycle before the chain step.
#   - A successful sync touches BACKUP_OK_PATH (healthcheck consumer: issue #72).
#
# Remote-call budget (B2 Class C daily cap incident, 2026-10-04):
#   Every rclone invocation re-authorizes and lists (B2 Class C calls). The cycle
#   therefore compares a LOCAL fingerprint of blobs/ and chain.jsonl against the
#   fingerprint of the last successful upload and makes zero remote calls when
#   nothing changed. The fingerprint is taken BEFORE uploading, so an append that
#   lands mid-upload is still seen as a change on the next cycle.
#   - BACKUP_VERIFY_SEC: force a real round-trip at least this often even when
#     idle, so a revoked key / deleted bucket surfaces within that window.
#   - BACKUP_RETRY_SEC: after a failure, an unchanged fingerprint is retried at
#     most this often (new appends still retry immediately) — a stuck shrink
#     refusal or exhausted cap must not burn calls every interval.
set -euo pipefail

# Primary env (T6.1 spec); aliases match ops/compose.ghost.yml from Workstream A
BACKUP_SOURCE_DIR="${BACKUP_SOURCE_DIR:-${BACKUP_WATCH_PATH:-/data/soulchain}}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-${BACKUP_REMOTE:-}}"
BACKUP_DEBOUNCE_SEC="${BACKUP_DEBOUNCE_SEC:-30}"
BACKUP_INTERVAL_SEC="${BACKUP_INTERVAL_SEC:-300}"
BACKUP_VERIFY_SEC="${BACKUP_VERIFY_SEC:-86400}"
BACKUP_RETRY_SEC="${BACKUP_RETRY_SEC:-900}"
RCLONE_CONFIG="${RCLONE_CONFIG:-${BACKUP_RCLONE_CONFIG:-}}"
ALLOW_CHAIN_SHRINK="${ALLOW_CHAIN_SHRINK:-}"
BACKUP_OK_PATH="${BACKUP_OK_PATH:-/tmp/backup.ok}"
BACKUP_ONCE="${BACKUP_ONCE:-}"

if [[ -z "$BACKUP_RCLONE_REMOTE" ]]; then
  echo "[backup-watch] ERROR: BACKUP_RCLONE_REMOTE is required (e.g. ghostbackup:soulchain)" >&2
  exit 1
fi

# Content digest of stdin. Prefer cksum; fall back for minimal busybox builds
# (no cksum applet) and macOS (md5, no md5sum).
digest_stdin() {
  if command -v cksum >/dev/null 2>&1; then
    cksum | tr -s ' ' ':'
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum | cut -d' ' -f1
  else
    md5 -q
  fi
}

# Per (source, remote) state so a dev machine pointing one script at several
# remotes never reuses another remote's "already uploaded" fingerprint.
if [[ -z "${BACKUP_STATE_DIR:-}" ]]; then
  state_key="$(printf "%s|%s" "$BACKUP_SOURCE_DIR" "$BACKUP_RCLONE_REMOTE" | digest_stdin | cut -d: -f1)"
  BACKUP_STATE_DIR="/tmp/backup-watch-state/${state_key}"
fi
mkdir -p "$BACKUP_STATE_DIR"

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

# --- upload-state bookkeeping (local files only; no remote calls) ---

state_get() {
  local file="${BACKUP_STATE_DIR}/$1"
  if [[ -f "$file" ]]; then
    cat "$file"
  fi
}

# Atomic replace so the periodic and debounced subshells never read a torn value.
state_set() {
  local file="${BACKUP_STATE_DIR}/$1"
  printf "%s" "$2" >"${file}.tmp.${BASHPID:-$$}"
  mv -f "${file}.tmp.${BASHPID:-$$}" "$file"
}

state_clear() {
  rm -f "${BACKUP_STATE_DIR}/$1"
}

# Exact content fingerprint of chain.jsonl (byte count + digest). Cheap at
# soulchain scale and immune to same-second / same-size rewrites after recovery.
chain_signature() {
  local chain_path="$1"
  if [[ ! -f "$chain_path" ]]; then
    echo "missing"
    return 0
  fi
  echo "$(stat_size "$chain_path"):$(digest_stdin <"$chain_path")"
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

# Record a failed cycle for this fingerprint (drives BACKUP_RETRY_SEC backoff).
mark_failed() {
  state_set failed.sig "$1"
  state_set failed.at "$(date +%s)"
}

# Upload soulchain to remote.
#   $1 = "auto" (default): skip remote calls when the local fingerprint matches
#        the last successful upload and the verify window has not elapsed.
#   $1 = "force": always round-trip (startup, BACKUP_ONCE drills).
# Returns 0 on success, benign skip, or backoff; 1 on shrink refuse / rclone failure.
sync_backup() {
  local mode="${1:-auto}"
  local blobs_src="${BACKUP_SOURCE_DIR}/blobs"
  local chain_src="${BACKUP_SOURCE_DIR}/chain.jsonl"

  if [[ ! -d "$blobs_src" ]]; then
    log "WARN: blobs directory missing: $blobs_src"
    return 0
  fi
  if [[ ! -f "$chain_src" ]]; then
    log "WARN: chain.jsonl missing: $chain_src"
    return 0
  fi

  local now verified_at verify_due=0
  now="$(date +%s)"
  verified_at="$(state_get verified.at)"
  if (( now - ${verified_at:-0} >= BACKUP_VERIFY_SEC )); then
    verify_due=1
  fi

  # Fast path: nothing changed since the last successful upload → zero remote
  # calls. The remote still holds exactly that state, so the backup is current
  # and the healthcheck marker may be refreshed.
  if [[ "$mode" != "force" && "$verify_due" -eq 0 \
    && "$(chain_signature "$chain_src")" == "$(state_get chain.sig)" \
    && "$(blob_signature)" == "$(state_get blobs.sig)" ]]; then
    touch "$BACKUP_OK_PATH"
    return 0
  fi

  # Snapshot the chain FIRST, then fingerprint blobs/. The runtime writes a blob
  # before the chain line that references it, so every blob the snapshot needs
  # already exists when blobs/ is fingerprinted and copied. Uploading the snapshot
  # (not the live file) keeps an append that lands mid-cycle — possibly
  # referencing a blob this cycle did not copy — out of the remote tip; the next
  # cycle picks it up.
  local snap="${BACKUP_STATE_DIR}/chain.snapshot.${BASHPID:-$$}"
  if ! cp -p "$chain_src" "$snap"; then
    log "ERROR: could not snapshot chain.jsonl"
    rm -f "$snap"
    return 1
  fi
  local rc=0
  upload_cycle "$mode" "$verify_due" "$now" "$snap" || rc=$?
  rm -f "$snap"
  return "$rc"
}

# One upload cycle against a chain snapshot. See sync_backup for arguments.
upload_cycle() {
  local mode="$1" verify_due="$2" now="$3" snap="$4"
  local blobs_src="${BACKUP_SOURCE_DIR}/blobs"
  local remote="${BACKUP_RCLONE_REMOTE}"
  local remote_chain="${remote}/chain.jsonl"
  local local_size remote_size history_ts

  # Fingerprints are taken BEFORE uploading: if anything changes mid-cycle, the
  # recorded fingerprint is the older one and the next cycle sees the change.
  local chain_sig blob_sig cycle_sig
  chain_sig="$(chain_signature "$snap")"
  blob_sig="$(blob_signature)"
  cycle_sig="${blob_sig}|${chain_sig}"

  local blobs_dirty=1 chain_dirty=1
  if [[ "$mode" != "force" && "$verify_due" -eq 0 ]]; then
    [[ "$blob_sig" == "$(state_get blobs.sig)" ]] && blobs_dirty=0
    [[ "$chain_sig" == "$(state_get chain.sig)" ]] && chain_dirty=0
  fi
  if (( blobs_dirty == 0 && chain_dirty == 0 )); then
    touch "$BACKUP_OK_PATH"
    return 0
  fi

  if [[ "$mode" != "force" && "$cycle_sig" == "$(state_get failed.sig)" ]]; then
    local failed_at
    failed_at="$(state_get failed.at)"
    if (( now - ${failed_at:-0} < BACKUP_RETRY_SEC )); then
      return 0
    fi
    log "Retrying previously failed cycle (unchanged since failure; BACKUP_RETRY_SEC=${BACKUP_RETRY_SEC})"
  fi

  # Blobs are immutable CIDs — copy only; never delete remote orphans.
  if (( blobs_dirty == 1 )); then
    log "Copying blobs/ → ${remote}/blobs/ (append-only; never deletes remote)"
    if ! rclone copy "$blobs_src" "${remote}/blobs" "${RCLONE_ARGS[@]}"; then
      log "ERROR: blob copy failed; skipping chain upload so the remote tip never references missing blobs"
      mark_failed "$cycle_sig"
      return 1
    fi
    state_set blobs.sig "$blob_sig"
  fi

  if (( chain_dirty == 1 )); then
    local_size="$(stat_size "$snap")"
    if ! remote_size="$(remote_chain_size "$remote_chain")"; then
      log "ERROR: could not determine remote chain.jsonl size; refusing upload (shrink guard cannot run safely)"
      mark_failed "$cycle_sig"
      return 1
    fi

    if (( local_size < remote_size )); then
      if [[ "$ALLOW_CHAIN_SHRINK" != "1" ]]; then
        log "ERROR: refusing to upload smaller chain.jsonl (local=${local_size} remote=${remote_size}); set ALLOW_CHAIN_SHRINK=1 to override"
        mark_failed "$cycle_sig"
        return 1
      fi
      log "WARN: ALLOW_CHAIN_SHRINK=1 — uploading smaller chain.jsonl (local=${local_size} remote=${remote_size}); previous tip moves to history/"
    fi

    # Preserve the prior tip under history/<UTC>-<pid>/ before overwriting the live tip.
    # Prefer BASHPID so debounce/periodic subshells get distinct suffixes within one second;
    # fall back to $$ for non-bash shells (cross-process uniqueness still holds).
    history_ts="$(date -u +"%Y%m%dT%H%M%SZ")-${BASHPID:-$$}"
    log "Copying chain.jsonl → ${remote_chain} (backup-dir history/${history_ts})"
    if ! rclone copyto "$snap" "$remote_chain" \
      --backup-dir "${remote}/history/${history_ts}" \
      "${RCLONE_ARGS[@]}"; then
      log "ERROR: chain.jsonl upload failed"
      mark_failed "$cycle_sig"
      return 1
    fi
    state_set chain.sig "$chain_sig"
  fi

  state_set verified.at "$now"
  state_clear failed.sig
  state_clear failed.at
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
log "  interval: ${BACKUP_INTERVAL_SEC}s (local fingerprint check; remote only on change)"
log "  verify:   ${BACKUP_VERIFY_SEC}s (forced remote round-trip when idle)"
log "  retry:    ${BACKUP_RETRY_SEC}s (backoff for an unchanged failed cycle)"
log "  ok path:  $BACKUP_OK_PATH"
log "  state:    $BACKUP_STATE_DIR"
if [[ "$BACKUP_ONCE" == "1" ]]; then
  log "  mode:     once (BACKUP_ONCE=1)"
  if sync_backup force; then
    exit 0
  fi
  exit 1
fi

(
  while true; do
    sleep "$BACKUP_INTERVAL_SEC"
    sync_backup || log "WARN: periodic sync failed"
  done
) &
PERIODIC_PID=$!

sync_backup force || log "WARN: initial sync failed"

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
