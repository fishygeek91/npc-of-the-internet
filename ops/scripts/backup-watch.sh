#!/usr/bin/env bash
# Append-triggered soulchain backup via rclone.
# Watches BACKUP_SOURCE_DIR and debounces uploads to BACKUP_RCLONE_REMOTE.
#
# Durability contract (Bug #63):
#   - blobs/ are content-addressed and immutable → rclone copy (never sync). The
#     only remote deletion is erasure propagation (below), restricted to blob CIDs
#     named by strictly-parsed tombstone records.
#   - chain.jsonl is append-only → refuse size regression unless ALLOW_CHAIN_SHRINK=1;
#     an overwritten tip is preserved under remote/history/<UTC>-<pid>/ via
#     --backup-dir at most once per BACKUP_HISTORY_SEC (rollback points).
#   - Blobs reach the remote before the chain tip that references them: the chain
#     is snapshotted before blobs/ is listed, the snapshot is what gets uploaded,
#     and a failed blob copy aborts the cycle before the chain step.
#   - A successful sync (or a policy skip, below) touches BACKUP_OK_PATH
#     (healthcheck consumer: issue #72).
#
# Remote-call budget (B2 Class C cap incident 2026-10-04; redesign 2026-10-05):
#   Every rclone invocation re-authorizes, and lists unless told not to; those are
#   B2 Class C calls (free accounts: 2,500/day account-wide).
#   - Local fingerprints (chain size+digest; blob SET identity = digest of the
#     sorted "name size" list) are compared against the last successful upload;
#     unchanged → zero remote calls. Fingerprints are taken BEFORE uploading, so
#     an append that lands mid-upload is still seen as a change next cycle.
#   - New blobs: the "name size" entries already uploaded are tracked locally and
#     only new entries are sent, with --files-from --no-traverse --no-check-dest
#     (content-addressed + immutable → idempotent; no remote listing). A full
#     `rclone copy` (normal checks → self-heal) runs only on force/verify cycles.
#   - Heartbeat deferral: if every record appended since the last uploaded chain
#     is a heartbeat attestation (the runtime writes one every 10 min), the upload
#     waits until BACKUP_HEARTBEAT_DEFER_SEC after the last successful chain
#     upload. Any other record uploads promptly (after debounce). The healthcheck
#     stays green while deferring: by policy the remote is current enough.
#   - Shrink guard compares against the last uploaded size kept in local state;
#     `lsjson` runs only on force/verify cycles or when that state is missing.
#   - BACKUP_VERIFY_SEC: a full round-trip (full copy + lsjson + copyto) at least
#     this often, so a revoked key / deleted bucket / lost object surfaces and heals.
#   - BACKUP_RETRY_SEC: after a failure, an unchanged fingerprint is retried at
#     most this often (new appends still retry immediately).
#
# Erasure propagation (spec/osp/privacy.md §6): tombstone records appended since
# the last upload (plus a full chain scan on force/verify cycles) name blob CIDs
# that must leave infrastructure we control. After the chain carrying the
# tombstone is uploaded, exactly those CIDs (strict CID format; never a chain
# record CID) are deleted from remote blobs/ and are never uploaded again.
#
# Concurrency: periodic, debounced and startup cycles serialize on a lock in the
# state dir (flock; mkdir-lock fallback). Signals: TERM/INT exit 143 promptly and
# kill every child process (subshells, sleeps, rclone, inotifywait).
set -euo pipefail

# Primary env (T6.1 spec); aliases match ops/compose.ghost.yml from Workstream A
BACKUP_SOURCE_DIR="${BACKUP_SOURCE_DIR:-${BACKUP_WATCH_PATH:-/data/soulchain}}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-${BACKUP_REMOTE:-}}"
BACKUP_DEBOUNCE_SEC="${BACKUP_DEBOUNCE_SEC:-30}"
BACKUP_INTERVAL_SEC="${BACKUP_INTERVAL_SEC:-300}"
BACKUP_VERIFY_SEC="${BACKUP_VERIFY_SEC:-86400}"
BACKUP_RETRY_SEC="${BACKUP_RETRY_SEC:-900}"
BACKUP_HEARTBEAT_DEFER_SEC="${BACKUP_HEARTBEAT_DEFER_SEC:-3600}"
BACKUP_HISTORY_SEC="${BACKUP_HISTORY_SEC:-86400}"
RCLONE_CONFIG="${RCLONE_CONFIG:-${BACKUP_RCLONE_CONFIG:-}}"
ALLOW_CHAIN_SHRINK="${ALLOW_CHAIN_SHRINK:-}"
BACKUP_OK_PATH="${BACKUP_OK_PATH:-/tmp/backup.ok}"
BACKUP_ONCE="${BACKUP_ONCE:-}"

if [[ -z "$BACKUP_RCLONE_REMOTE" ]]; then
  echo "[backup-watch] ERROR: BACKUP_RCLONE_REMOTE is required (e.g. ghostbackup:soulchain)" >&2
  exit 1
fi

# The periodic loop re-checks a pending deferral deadline at least this often;
# a cycle only defers while more than DEFER_TICK_SEC of the window remains, so a
# heartbeat-only change reaches the remote no later than
# (last chain upload + BACKUP_HEARTBEAT_DEFER_SEC), plus the cycle's own runtime.
DEFER_TICK_SEC=30
if (( BACKUP_INTERVAL_SEC < DEFER_TICK_SEC )); then
  DEFER_TICK_SEC="$BACKUP_INTERVAL_SEC"
fi
(( DEFER_TICK_SEC >= 1 )) || DEFER_TICK_SEC=1

# osp CIDs (osp-core CID_RE): CIDv1 dag-json sha2-256 base32.
CID_ERE='bagu[a-z2-7]{57}'
# Heartbeat attestation in canonical JSON (sorted keys, no whitespace): a flat
# body (no nested object) carrying "kind":"heartbeat", and top-level type
# "attestation" (always the last key). JSON strings escape '"', so the literal
# "kind":"heartbeat" can only be a real key/value pair. Anything that does not
# match uploads promptly (the safe direction). Brackets avoid \{ portability gaps.
HEARTBEAT_ERE='^[{]"body":[{][^{}]*"kind":"heartbeat"[^{}]*[}],.*"type":"attestation"[}]$'
# Tombstone (spec/osp/records.md §Type: tombstone); capture group 1 = blob_cid.
TOMBSTONE_ERE='^[{]"body":[{]"blob_cid":"('"$CID_ERE"')","erased_at":"[0-9TZ:.+-]+","reason":"(erasure_request|dmca|illegal_content|operator)","target_cid":"'"$CID_ERE"'"[}],"cosigners":[[][]],"prev":"'"$CID_ERE"'","residency":null,"seq":[0-9]+,"sig":"[A-Za-z0-9_-]+","spec":"osp/0[.]2","type":"tombstone"[}]$'

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
LOCK_FILE="${BACKUP_STATE_DIR}/sync.lock"

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

state_path() {
  echo "${BACKUP_STATE_DIR}/$1"
}

state_get() {
  local file="${BACKUP_STATE_DIR}/$1"
  if [[ -f "$file" ]]; then
    cat "$file"
  fi
}

# Atomic replace so a reader never sees a torn value.
state_set() {
  local file="${BACKUP_STATE_DIR}/$1"
  printf "%s" "$2" >"${file}.tmp.${BASHPID:-$$}"
  mv -f "${file}.tmp.${BASHPID:-$$}" "$file"
}

# Atomically replace a state file with the contents of a local file.
state_set_file() {
  local file="${BACKUP_STATE_DIR}/$1"
  cp "$2" "${file}.tmp.${BASHPID:-$$}"
  mv -f "${file}.tmp.${BASHPID:-$$}" "$file"
}

state_clear() {
  rm -f "${BACKUP_STATE_DIR}/$1"
}

# Lines of $2 ("name size" or bare names) whose name is not listed in file $1.
# FILENAME (not NR==FNR) so an empty $1 filters nothing instead of everything.
without_names() {
  awk 'FILENAME == ARGV[1] { gone[$0] = 1; next } { n = $0; sub(/ [0-9]+$/, "", n) } NF && !(n in gone)' "$1" "$2"
}

# Lines of $2 not present verbatim in file $1 (same empty-$1 caveat as above).
without_lines() {
  awk 'FILENAME == ARGV[1] { seen[$0] = 1; next } NF && !($0 in seen)' "$1" "$2"
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

# Sorted "relative-name size" list of every file under blobs/ (C collation).
blob_manifest() {
  local blobs_dir="${BACKUP_SOURCE_DIR}/blobs"
  [[ -d "$blobs_dir" ]] || return 0
  local fmt=(-c '%n %s')
  if ! stat -c%s "$blobs_dir" >/dev/null 2>&1; then
    fmt=(-f '%N %z')
  fi
  # osp-core writes blobs atomically via a short-lived ".tmp-*" file in the
  # same directory; such in-flight temp files are never fingerprinted or
  # uploaded (the rename to the CID name is what makes a blob exist).
  (cd "$blobs_dir" && find . -type f -exec stat "${fmt[@]}" {} + 2>/dev/null) \
    | sed 's#^\./##' | grep -v '^\.tmp-' | LC_ALL=C sort
}

# Set identity of blobs/: digest of the sorted name+size list (renames and
# same-count/same-total-size swaps change it; a count:size pair would not).
blob_signature() {
  if [[ ! -d "${BACKUP_SOURCE_DIR}/blobs" ]]; then
    echo "missing"
    return 0
  fi
  blob_manifest | digest_stdin
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
  # Bucket remotes (B2, S3) have no real directories: lsjson on a missing object
  # exits 0 and prints an empty array split across lines ("[" newline "]"), so
  # compare with whitespace removed. Missing remote tip = size 0 (first upload).
  local compact
  compact="$(printf "%s" "$json" | tr -d '[:space:]')"
  if [[ -z "$compact" || "$compact" == "[]" ]]; then
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

# Classify what was appended since the last uploaded chain.
#   $1 = chain snapshot, $2 = file that receives the appended bytes.
# Prints "empty" | "heartbeat" | "other". "other" (with $2 left empty) whenever
# the snapshot is not a pure append of the uploaded chain or state is missing.
classify_tail() {
  local snap="$1" tail_file="$2"
  : >"$tail_file"
  local prev_sig prev_size snap_size
  prev_sig="$(state_get chain.sig)"
  prev_size="$(state_get chain.size)"
  if [[ -z "$prev_sig" || -z "$prev_size" ]]; then
    echo "other"
    return 0
  fi
  snap_size="$(stat_size "$snap")"
  if (( snap_size < prev_size )); then
    echo "other"
    return 0
  fi
  # The uploaded prefix must be byte-identical (pure append).
  if [[ "${prev_size}:$(head -c "$prev_size" "$snap" | digest_stdin)" != "$prev_sig" ]]; then
    echo "other"
    return 0
  fi
  tail -c +"$((prev_size + 1))" "$snap" >"$tail_file"
  if [[ ! -s "$tail_file" ]]; then
    echo "empty"
    return 0
  fi
  # A torn (unterminated) trailing line is never classified as a heartbeat.
  if [[ -n "$(tail -c 1 "$tail_file")" ]]; then
    echo "other"
    return 0
  fi
  local non_heartbeat
  non_heartbeat="$(grep -Evc "$HEARTBEAT_ERE" "$tail_file" || true)"
  if [[ "${non_heartbeat:-1}" == "0" ]]; then
    echo "heartbeat"
  else
    echo "other"
  fi
}

# Print (sorted, unique) blob CIDs named by strictly-parsed tombstone lines in
# file $1. A CID that is also a chain record CID (a "prev" link in snapshot $2)
# is refused: record bytes share the blob namespace and must never be deleted.
# Diagnostics go to stderr (stdout is the CID list).
tombstoned_cids() {
  local file="$1" chain="$2"
  local loose strict strict_n=0 cid
  loose="$(grep -c '"type":"tombstone"}$' "$file" || true)"
  strict="$(sed -n -E "s#${TOMBSTONE_ERE}#\\1#p" "$file")"
  if [[ -n "$strict" ]]; then
    strict_n="$(printf "%s\n" "$strict" | wc -l | tr -d ' ')"
  fi
  if (( ${loose:-0} > strict_n )); then
    log "WARN: $(( loose - strict_n )) tombstone line(s) did not match the strict shape; their blobs are NOT deleted remotely (TROUBLESHOOTING.md: Erasure)" >&2
  fi
  [[ -n "$strict" ]] || return 0
  while IFS= read -r cid; do
    [[ "$cid" =~ ^bagu[a-z2-7]{57}$ ]] || continue
    if grep -qF "\"prev\":\"${cid}\"" "$chain"; then
      log "WARN: tombstoned blob ${cid} is a chain record CID; refusing remote delete" >&2
      continue
    fi
    printf "%s\n" "$cid"
  done <<<"$strict" | LC_ALL=C sort -u
}

# Upload soulchain to remote.
#   $1 = "auto" (default): skip remote calls when the local fingerprint matches
#        the last successful upload, or defer a heartbeat-only change.
#   $1 = "force": always a full round-trip (startup, BACKUP_ONCE drills).
# Returns 0 on success, benign skip, deferral or backoff; 1 on shrink refuse /
# rclone failure. Callers serialize via locked_sync.
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

  local now verified_at full=0
  now="$(date +%s)"
  verified_at="$(state_get verified.at)"
  if [[ "$mode" == "force" ]] || (( now - ${verified_at:-0} >= BACKUP_VERIFY_SEC )); then
    full=1
  fi

  # Fast path: nothing changed since the last successful upload → zero remote
  # calls. The remote still holds exactly that state, so the backup is current
  # and the healthcheck marker may be refreshed.
  if (( full == 0 )) \
    && [[ ! -s "$(state_path erase.pending)" ]] \
    && [[ "$(chain_signature "$chain_src")" == "$(state_get chain.sig)" ]] \
    && [[ "$(blob_signature)" == "$(state_get blobs.sig)" ]]; then
    touch "$BACKUP_OK_PATH"
    return 0
  fi

  # Snapshot the chain FIRST, then list blobs/. The runtime writes a blob before
  # the chain line that references it, so every blob the snapshot needs already
  # exists when blobs/ is listed and copied. Uploading the snapshot (not the
  # live file) keeps an append that lands mid-cycle — possibly referencing a
  # blob this cycle did not copy — out of the remote tip; the next cycle picks
  # it up.
  local tag="${BASHPID:-$$}"
  local snap="${BACKUP_STATE_DIR}/chain.snapshot.${tag}"
  if ! cp -p "$chain_src" "$snap"; then
    log "ERROR: could not snapshot chain.jsonl"
    rm -f "$snap"
    return 1
  fi
  local rc=0
  upload_cycle "$full" "$now" "$snap" "$tag" || rc=$?
  rm -f "$snap" "${BACKUP_STATE_DIR}/"*".cycle.${tag}"
  return "$rc"
}

# One upload cycle against a chain snapshot. See sync_backup for arguments.
upload_cycle() {
  local full="$1" now="$2" snap="$3" tag="$4"
  local blobs_src="${BACKUP_SOURCE_DIR}/blobs"
  local remote="${BACKUP_RCLONE_REMOTE}"
  local remote_chain="${remote}/chain.jsonl"
  local tmp="${BACKUP_STATE_DIR}"
  local manifest="${tmp}/manifest.cycle.${tag}"
  local tail_file="${tmp}/tail.cycle.${tag}"
  local erased="${tmp}/erased.cycle.${tag}"
  local uploaded="${tmp}/uploaded.cycle.${tag}"
  local pending="${tmp}/pending.cycle.${tag}"
  local local_size remote_size

  # Fingerprints are taken BEFORE uploading: if anything changes mid-cycle, the
  # recorded fingerprint is the older one and the next cycle sees the change.
  local chain_sig blob_sig cycle_sig
  chain_sig="$(chain_signature "$snap")"
  blob_manifest >"$manifest"
  blob_sig="$(digest_stdin <"$manifest")"
  cycle_sig="${blob_sig}|${chain_sig}"

  local blobs_dirty=1 chain_dirty=1 pending_erase=0
  if (( full == 0 )); then
    [[ "$blob_sig" == "$(state_get blobs.sig)" ]] && blobs_dirty=0
    [[ "$chain_sig" == "$(state_get chain.sig)" ]] && chain_dirty=0
  fi
  [[ -s "$(state_path erase.pending)" ]] && pending_erase=1
  if (( blobs_dirty == 0 && chain_dirty == 0 && pending_erase == 0 )); then
    touch "$BACKUP_OK_PATH"
    return 0
  fi

  local tail_kind
  tail_kind="$(classify_tail "$snap" "$tail_file")"

  # Heartbeat deferral: only heartbeats (or only blobs no uploaded record needs)
  # since the last chain upload, and the window has not run out. Never while a
  # failure is outstanding — deferring would refresh the healthcheck marker and
  # hide it.
  if (( full == 0 && pending_erase == 0 )) \
    && [[ -z "$(state_get failed.sig)" ]] \
    && [[ "$tail_kind" == "empty" || "$tail_kind" == "heartbeat" ]]; then
    local chain_at deadline
    chain_at="$(state_get chain.at)"
    if [[ -n "$chain_at" ]]; then
      deadline=$(( chain_at + BACKUP_HEARTBEAT_DEFER_SEC - DEFER_TICK_SEC ))
      if (( now < deadline )); then
        if [[ "$(state_get defer.until)" != "$deadline" ]]; then
          state_set defer.until "$deadline"
          log "Deferring ${tail_kind}-only change (no remote calls) for up to $(( deadline - now ))s (BACKUP_HEARTBEAT_DEFER_SEC=${BACKUP_HEARTBEAT_DEFER_SEC})"
        fi
        touch "$BACKUP_OK_PATH"
        return 0
      fi
    fi
  fi

  if (( full == 0 )) && [[ "$cycle_sig" == "$(state_get failed.sig)" ]]; then
    local failed_at
    failed_at="$(state_get failed.at)"
    if (( now - ${failed_at:-0} < BACKUP_RETRY_SEC )); then
      return 0
    fi
    log "Retrying previously failed cycle (unchanged since failure; BACKUP_RETRY_SEC=${BACKUP_RETRY_SEC})"
  fi

  # Erased CIDs (deleted or pending deletion) are never uploaded again.
  { state_get erase.done; state_get erase.pending; } | LC_ALL=C sort -u >"$erased"

  # --- 1. blobs (immutable CIDs — copy only; never delete remote orphans) ---
  if (( blobs_dirty == 1 )); then
    if (( full == 1 )); then
      local exclude=(--exclude ".tmp-*")
      [[ -s "$erased" ]] && exclude+=(--exclude-from "$erased")
      log "Copying blobs/ → ${remote}/blobs/ (full check; append-only; never deletes remote)"
      if ! rclone copy "$blobs_src" "${remote}/blobs" "${exclude[@]}" "${RCLONE_ARGS[@]}"; then
        log "ERROR: blob copy failed; skipping chain upload so the remote tip never references missing blobs"
        mark_failed "$cycle_sig"
        return 1
      fi
      without_names "$erased" "$manifest" >"$uploaded"
    else
      local new_entries="${tmp}/new.cycle.${tag}" new_names="${tmp}/newnames.cycle.${tag}"
      # Entries ("name size") not yet uploaded; a size change re-sends the name.
      state_get blobs.uploaded >"$uploaded"
      without_lines "$uploaded" "$manifest" \
        | without_names "$erased" - >"$new_entries"
      sed 's/ [0-9][0-9]*$//' "$new_entries" >"$new_names"
      if [[ -s "$new_names" ]]; then
        log "Copying $(wc -l <"$new_names" | tr -d ' ') new blob(s) → ${remote}/blobs/ (files-from; no remote listing)"
        if ! rclone copy "$blobs_src" "${remote}/blobs" \
          --files-from "$new_names" --no-traverse --no-check-dest \
          "${RCLONE_ARGS[@]}"; then
          log "ERROR: blob copy failed; skipping chain upload so the remote tip never references missing blobs"
          mark_failed "$cycle_sig"
          return 1
        fi
      fi
      cat "$new_entries" >>"$uploaded"
      LC_ALL=C sort -u -o "$uploaded" "$uploaded"
    fi
    state_set_file blobs.uploaded "$uploaded"
    state_set blobs.sig "$blob_sig"
  fi

  # --- 2. chain tip ---
  if (( chain_dirty == 1 )); then
    local_size="$(stat_size "$snap")"
    local known_size
    known_size="$(state_get chain.size)"
    if (( full == 1 )) || [[ -z "$known_size" ]]; then
      if ! remote_size="$(remote_chain_size "$remote_chain")"; then
        log "ERROR: could not determine remote chain.jsonl size; refusing upload (shrink guard cannot run safely)"
        mark_failed "$cycle_sig"
        return 1
      fi
    else
      remote_size="$known_size"
    fi

    if (( local_size < remote_size )); then
      if [[ "$ALLOW_CHAIN_SHRINK" != "1" ]]; then
        log "ERROR: refusing to upload smaller chain.jsonl (local=${local_size} remote=${remote_size}); set ALLOW_CHAIN_SHRINK=1 to override"
        mark_failed "$cycle_sig"
        return 1
      fi
      log "WARN: ALLOW_CHAIN_SHRINK=1 — uploading smaller chain.jsonl (local=${local_size} remote=${remote_size}); previous tip moves to history/"
    fi

    # Preserve the prior tip under history/<UTC>-<pid>/ at most once per
    # BACKUP_HISTORY_SEC (a shrink override always snapshots). The pid suffix
    # keeps names distinct within one second.
    local history_args=() history_ts="" history_at
    history_at="$(state_get history.at)"
    if (( local_size < remote_size )) || (( now - ${history_at:-0} >= BACKUP_HISTORY_SEC )); then
      history_ts="$(date -u +"%Y%m%dT%H%M%SZ")-${BASHPID:-$$}"
      history_args=(--backup-dir "${remote}/history/${history_ts}")
      log "Copying chain.jsonl → ${remote_chain} (backup-dir history/${history_ts})"
    else
      log "Copying chain.jsonl → ${remote_chain} (history snapshot not due)"
    fi
    if ! rclone copyto "$snap" "$remote_chain" "${history_args[@]}" "${RCLONE_ARGS[@]}"; then
      log "ERROR: chain.jsonl upload failed"
      mark_failed "$cycle_sig"
      return 1
    fi
    # The window restarts only when a different prior tip was actually moved
    # (identical tips are skipped by copyto; a missing tip has nothing to keep).
    if [[ -n "$history_ts" ]] && (( remote_size > 0 && remote_size != local_size )); then
      state_set history.at "$now"
    fi
    state_set chain.sig "$chain_sig"
    state_set chain.size "$local_size"
    state_set chain.at "$now"
    state_clear defer.until
  fi

  # --- 3. erasure propagation (after the tombstone-bearing tip is uploaded) ---
  local erase_done="${tmp}/done.cycle.${tag}"
  state_get erase.done >"$erase_done"
  {
    state_get erase.pending
    if (( full == 1 )) || [[ "$tail_kind" == "other" && ! -s "$tail_file" ]]; then
      # Full scan on force/verify, and when the chain is not a pure append.
      tombstoned_cids "$snap" "$snap"
    else
      tombstoned_cids "$tail_file" "$snap"
    fi
  } | LC_ALL=C sort -u \
    | without_lines "$erase_done" - >"$pending"
  if [[ -s "$pending" ]]; then
    state_set_file erase.pending "$pending"
    log "Erasure: deleting $(wc -l <"$pending" | tr -d ' ') tombstoned blob(s) from ${remote}/blobs/"
    # --files-from: direct per-name lookups, exactly these objects. B2 hides on
    # delete by default; --b2-hard-delete removes the version (ignored elsewhere).
    if ! rclone delete "${remote}/blobs" --files-from "$pending" --b2-hard-delete "${RCLONE_ARGS[@]}"; then
      log "ERROR: erasure delete failed; will retry"
      mark_failed "$cycle_sig"
      return 1
    fi
    { state_get erase.done; cat "$pending"; } | LC_ALL=C sort -u >"$erased"
    state_set_file erase.done "$erased"
    state_get blobs.uploaded | without_names "$pending" - >"$uploaded"
    state_set_file blobs.uploaded "$uploaded"
    state_clear erase.pending
    log "Erasure: remote delete complete"
  fi

  if (( full == 1 )); then
    state_set verified.at "$now"
  fi
  state_clear failed.sig
  state_clear failed.at
  touch "$BACKUP_OK_PATH"
  log "Sync complete (marker ${BACKUP_OK_PATH})"
}

# Serialize cycles (periodic, debounced, startup) on a lock in the state dir.
locked_sync() {
  if command -v flock >/dev/null 2>&1; then
    (
      flock 9 || exit 1
      sync_backup "$@"
    ) 9>"$LOCK_FILE"
    return $?
  fi
  # mkdir-lock fallback (no flock): owner pid inside; stale once that pid is gone.
  local dir="${LOCK_FILE}.d" owner waited=0 me="${BASHPID:-$$}"
  until mkdir "$dir" 2>/dev/null; do
    owner="$(cat "${dir}/pid" 2>/dev/null || true)"
    if { [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; } \
      || { [[ -z "$owner" ]] && (( waited >= 30 )); }; then
      rm -rf "$dir"
      continue
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$me" >"${dir}/pid"
  local rc=0
  sync_backup "$@" || rc=$?
  rm -rf "$dir"
  return "$rc"
}

DEBOUNCE_PID=""
PERIODIC_PID=""
STARTUP_PID=""
WAITER_PID=""
DEBOUNCE_FLAG="${BACKUP_STATE_DIR}/debounce.flag.$$"

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
        locked_sync || log "WARN: debounced sync failed"
      fi
    done
  ) &
  DEBOUNCE_PID=$!
}

# Local check every BACKUP_INTERVAL_SEC; also wakes for a pending heartbeat
# deferral deadline (re-read at least every DEFER_TICK_SEC).
periodic_loop() {
  local last_run now due deadline nap
  last_run="$(date +%s)"
  while true; do
    now="$(date +%s)"
    due=$(( last_run + BACKUP_INTERVAL_SEC ))
    deadline="$(state_get defer.until)"
    if [[ -n "$deadline" ]] && (( deadline > last_run && deadline < due )); then
      due="$deadline"
    fi
    if (( now >= due )); then
      last_run="$now"
      locked_sync || log "WARN: periodic sync failed"
      continue
    fi
    nap=$(( due - now ))
    (( nap > DEFER_TICK_SEC )) && nap="$DEFER_TICK_SEC"
    sleep "$nap"
  done
}

# Direct children of pid $1 (pgrep -P; /proc scan when pgrep is absent).
child_pids() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$1" 2>/dev/null || true
    return 0
  fi
  local stat_file line rest ppid pid
  for stat_file in /proc/[0-9]*/stat; do
    line="$(cat "$stat_file" 2>/dev/null)" || continue
    rest="${line##*) }"
    read -r _ ppid _ <<<"$rest"
    if [[ "$ppid" == "$1" ]]; then
      pid="${stat_file#/proc/}"
      echo "${pid%/stat}"
    fi
  done
}

# Every descendant pid of $1, deepest first.
descendants() {
  local child
  for child in $(child_pids "$1"); do
    descendants "$child"
    echo "$child"
  done
}

cleanup() {
  trap - TERM INT
  rm -f "$DEBOUNCE_FLAG"
  local pids=() pid child
  # Collect the whole tree before killing: a dead subshell's children are
  # re-parented and no longer reachable through pgrep -P.
  for pid in "$DEBOUNCE_PID" "$PERIODIC_PID" "$STARTUP_PID" "$WAITER_PID"; do
    [[ -n "$pid" ]] || continue
    while IFS= read -r child; do
      [[ -n "$child" ]] && pids+=("$child")
    done < <(descendants "$pid")
    pids+=("$pid")
  done
  if (( ${#pids[@]} > 0 )); then
    kill "${pids[@]}" 2>/dev/null || true
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi
  # Stragglers spawned while collecting (e.g. a sleep started mid-cleanup).
  while IFS= read -r child; do
    if [[ -n "$child" ]]; then
      kill "$child" 2>/dev/null || true
    fi
  done < <(descendants "$$")
}
trap cleanup EXIT
trap 'exit 143' TERM INT

log "Starting backup watch"
log "  source:   $BACKUP_SOURCE_DIR"
log "  remote:   $BACKUP_RCLONE_REMOTE"
log "  debounce: ${BACKUP_DEBOUNCE_SEC}s"
log "  interval: ${BACKUP_INTERVAL_SEC}s (local fingerprint check; remote only on change)"
log "  verify:   ${BACKUP_VERIFY_SEC}s (full remote round-trip + self-heal)"
log "  retry:    ${BACKUP_RETRY_SEC}s (backoff for an unchanged failed cycle)"
log "  defer:    ${BACKUP_HEARTBEAT_DEFER_SEC}s (heartbeat-only appends batch up to this long)"
log "  history:  ${BACKUP_HISTORY_SEC}s (min spacing of history/ rollback points)"
log "  ok path:  $BACKUP_OK_PATH"
log "  state:    $BACKUP_STATE_DIR"
if [[ "$BACKUP_ONCE" == "1" ]]; then
  log "  mode:     once (BACKUP_ONCE=1)"
  locked_sync force &
  STARTUP_PID=$!
  once_rc=0
  wait "$STARTUP_PID" || once_rc=$?
  STARTUP_PID=""
  if (( once_rc == 0 )); then
    exit 0
  fi
  exit 1
fi

periodic_loop &
PERIODIC_PID=$!

# Startup round-trip runs in the background so TERM is handled promptly.
locked_sync force &
STARTUP_PID=$!
wait "$STARTUP_PID" || log "WARN: initial sync failed"
STARTUP_PID=""

if command -v inotifywait >/dev/null 2>&1; then
  log "Using inotifywait for change detection"
  while true; do
    inotifywait -qq -r -e modify,create,close_write,move,delete \
      "$BACKUP_SOURCE_DIR" 2>/dev/null &
    WAITER_PID=$!
    if ! wait "$WAITER_PID"; then
      sleep 2 &
      WAITER_PID=$!
      wait "$WAITER_PID" || true
    fi
    WAITER_PID=""
    log "Change detected"
    schedule_debounced_sync
  done
else
  log "inotifywait not available; polling mtime/size of chain.jsonl + blobs/"
  last_chain_mtime=""
  last_chain_size=""
  last_blob_sig=""

  while true; do
    sleep 2 &
    WAITER_PID=$!
    wait "$WAITER_PID" || true
    WAITER_PID=""
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
