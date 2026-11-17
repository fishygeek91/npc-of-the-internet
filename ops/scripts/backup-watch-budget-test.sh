#!/usr/bin/env bash
# Offline test: backup-watch.sh makes remote (rclone) calls only when the local
# soulchain changed in a way the remote needs (non-heartbeat records promptly;
# heartbeat-only appends once per BACKUP_HEARTBEAT_DEFER_SEC), the verify window
# elapsed, or a failed cycle's backoff expired — and every call it does make is
# the cheap form (no remote listing for new blobs, no lsjson outside verify).
# Regression guard for the 2026-10-04 B2 Class C cap exhaustion. No network:
# uses an rclone local-filesystem remote and a PATH shim that records rclone
# subcommands and arguments.
#
# Modes (BUDGET_TEST_MODE):
#   default  — PATH as is (inotifywait + flock when installed)
#   poll     — PATH without inotifywait, flock and pgrep (polling, mkdir-lock and
#              /proc child discovery fallbacks)
#   busybox  — busybox applets shadow coreutils/grep/sed/awk/find (alpine-like)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_WATCH="${SCRIPT_DIR}/backup-watch.sh"
REAL_RCLONE="$(command -v rclone || true)"
MODE="${BUDGET_TEST_MODE:-default}"

log() { echo "[backup-budget-test] $*"; }
die() {
  echo "[backup-budget-test] FAIL: $*" >&2
  if [[ -n "${TMP:-}" && -f "${TMP}/watch.log" ]]; then
    echo "--- watch.log (tail) ---" >&2
    tail -n 25 "${TMP}/watch.log" >&2 || true
  fi
  exit 1
}

[[ -n "$REAL_RCLONE" ]] || die "rclone not found on PATH"

TMP="$(mktemp -d)"
MARK="budget-test-$$-${RANDOM}"
WATCH_PID=""
cleanup() {
  if [[ -n "$WATCH_PID" ]] && kill -0 "$WATCH_PID" 2>/dev/null; then
    kill "$WATCH_PID" 2>/dev/null || true
    wait "$WATCH_PID" 2>/dev/null || true
  fi
  if [[ -n "${KEEP_TMP:-}" ]]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

SRC="${TMP}/soulchain"
REMOTE_DIR="${TMP}/remote"
SHIM="${TMP}/shim"
CALLS="${TMP}/rclone-calls.log"
ARGS_LOG="${TMP}/rclone-args.log"
FAIL_ON="${TMP}/fail-on"
SLOW="${TMP}/slow"
OVERLAP="${TMP}/overlap.log"
FULL_TIMES="${TMP}/full-copy-times.log"
STATE="${TMP}/state"
mkdir -p "${SRC}/blobs" "$REMOTE_DIR" "$SHIM"
: >"$CALLS"
: >"$ARGS_LOG"

cat >"${TMP}/rclone.conf" <<EOF
[testlocal]
type = local
EOF

# Shim: record each subcommand (CALLS) and full argv (ARGS_LOG, plus the content
# of any --files-from list); fail a subcommand listed in $FAIL_ON ("copy-full"
# fails only full checking copies, i.e. copy without --files-from, and records
# their start time in FULL_TIMES); when $SLOW
# exists, hold each call for 1s and record overlapping calls (cycles must be
# serialized). lsjson on a missing object mimics bucket remotes (B2/S3): exit 0
# with an empty multi-line array (the local backend would exit 3 instead).
cat >"${SHIM}/rclone" <<EOF
#!/usr/bin/env bash
echo "\$1" >>"${CALLS}"
echo "\$*" >>"${ARGS_LOG}"
args=("\$@")
kind="\$1"
[[ "\$1" == "copy" ]] && kind="copy-full"
for ((i = 0; i < \${#args[@]}; i++)); do
  if [[ "\${args[i]}" == "--files-from" ]]; then
    echo "files-from[\$1]: \$(tr '\n' ' ' <"\${args[i+1]}")" >>"${ARGS_LOG}"
    kind="\$1"
  fi
done
[[ "\$kind" == "copy-full" ]] && date +%s >>"${FULL_TIMES}"
if [[ -f "${SLOW}" ]]; then
  if mkdir "${TMP}/inflight" 2>/dev/null; then
    trap 'rmdir "${TMP}/inflight" 2>/dev/null' EXIT
  else
    echo "overlap: \$*" >>"${OVERLAP}"
  fi
  sleep 1
fi
if [[ -f "${FAIL_ON}" ]] && grep -qx -e "\$1" -e "\$kind" "${FAIL_ON}"; then
  exit 1
fi
if [[ "\$1" == "lsjson" && ! -e "\${2#testlocal:}" ]]; then
  printf '[\n]\n'
  exit 0
fi
"${REAL_RCLONE}" "\$@"
EOF
chmod +x "${SHIM}/rclone"

# PATH for the watcher under test.
WATCH_PATH="${SHIM}:${PATH}"
case "$MODE" in
  default) ;;
  poll)
    farm="${TMP}/bin"
    mkdir -p "$farm"
    IFS=: read -r -a path_dirs <<<"$PATH"
    for d in "${path_dirs[@]}"; do
      [[ -d "$d" ]] || continue
      for f in "$d"/*; do
        name="${f##*/}"
        case "$name" in inotifywait | flock | pgrep) continue ;; esac
        [[ -x "$f" && ! -e "${farm}/${name}" ]] && ln -s "$f" "${farm}/${name}"
      done
    done
    WATCH_PATH="${SHIM}:${farm}"
    ;;
  busybox)
    command -v busybox >/dev/null 2>&1 || die "busybox not installed"
    bb="${TMP}/bb"
    mkdir -p "$bb"
    for applet in $(busybox --list); do
      case "$applet" in bash | sh | rclone) continue ;; esac
      ln -s "$(command -v busybox)" "${bb}/${applet}"
    done
    WATCH_PATH="${SHIM}:${bb}:${PATH}"
    ;;
  *) die "unknown BUDGET_TEST_MODE=${MODE}" ;;
esac
log "mode: ${MODE}"

calls() { wc -l <"$CALLS" | tr -d ' '; }
count_of() { grep -cx "$1" "$CALLS" || true; }
calls_above() { (( $(calls) > $1 )); }
history_count() {
  if [[ -d "${REMOTE_DIR}/history" ]]; then
    find "${REMOTE_DIR}/history" -type f -name chain.jsonl | wc -l | tr -d ' '
  else
    echo 0
  fi
}

# wait_until <timeout-sec> <description> <command...>
wait_until() {
  local timeout="$1" desc="$2"
  shift 2
  local deadline=$(( $(date +%s) + timeout ))
  until "$@"; do
    (( $(date +%s) < deadline )) || die "timed out waiting for: ${desc}"
    sleep 0.2
  done
}

remote_chain_matches() { cmp -s "${SRC}/chain.jsonl" "${REMOTE_DIR}/chain.jsonl"; }

# --- canonical-shape record lines (sorted keys, no whitespace) ---
# Deterministic fake osp CID (bagu + 57 base32 chars) for name $1.
fake_cid() {
  local hex
  hex="$(printf "%s" "$1" | md5sum | cut -c1-32)$(printf "%s" "x$1" | md5sum | cut -c1-25)"
  printf "bagu%s" "$(printf "%s" "$hex" | tr '0189' 'wxyz')"
}
SEQ=10
PREV="$(fake_cid genesis)"
next_seq() { SEQ=$((SEQ + 1)); }
heartbeat_line() {
  next_seq
  printf '{"body":{"at":"2026-10-05T00:%02d:00.000Z","door_id":"discord:1","epoch":3,"kind":"heartbeat","pop_version":"pop/0.1","session_pubkey":"_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg"},"cosigners":["38WGbV7U1aFdAmrJYLkuTBWxGD0oTY_OLBoar1khRcnrPI30GCRke_fPJjqWuG10a9m-IbwJTzBaiv6-eOm6Aw"],"prev":"%s","residency":"door:discord:1/epoch:3","seq":%d,"sig":"S9gHk0qMmjZfrMjSG0C3prvfaKTjPgr1ekqzzswMdCat2PQbwb6aEyEJk9Ps85DzaQsCao883TbVQuE6V12aBw","spec":"osp/0.1","type":"attestation"}\n' \
    "$((SEQ % 60))" "$PREV" "$SEQ"
}
# A memory candidate whose text mentions heartbeats (must NOT be deferred).
memory_line() {
  next_seq
  printf '{"body":{"kind":"candidate","text":"my \\"kind\\":\\"heartbeat\\" felt slow today"},"cosigners":[],"prev":"%s","residency":"door:discord:1/epoch:3","seq":%d,"sig":"c2ln","spec":"osp/0.1","type":"memory"}\n' \
    "${1:-$PREV}" "$SEQ"
}
# A memory record referencing side blob $1 as its text_cid.
memory_text_line() {
  next_seq
  printf '{"body":{"kind":"candidate","text_cid":"%s"},"cosigners":[],"prev":"%s","residency":"door:discord:1/epoch:3","seq":%d,"sig":"c2ln","spec":"osp/0.2","type":"memory"}\n' \
    "$1" "$PREV" "$SEQ"
}
tombstone_line() {
  next_seq
  printf '{"body":{"blob_cid":"%s","erased_at":"2026-10-05T01:00:00.000Z","reason":"%s","target_cid":"%s"},"cosigners":[],"prev":"%s","residency":null,"seq":%d,"sig":"dG9tYnN0b25l","spec":"osp/0.2","type":"tombstone"}\n' \
    "$1" "${2:-erasure_request}" "$(fake_cid "target-$1")" "$PREV" "$SEQ"
}

printf '{"seq":0}\n' >"${SRC}/chain.jsonl"
printf 'blob-a' >"${SRC}/blobs/bafya"

# start_watch <verify-sec> <retry-sec> [defer-sec] [history-sec]
start_watch() {
  PATH="$WATCH_PATH" \
    BUDGET_TEST_MARK="$MARK" \
    BACKUP_SOURCE_DIR="$SRC" \
    BACKUP_RCLONE_REMOTE="testlocal:${REMOTE_DIR}" \
    RCLONE_CONFIG="${TMP}/rclone.conf" \
    BACKUP_STATE_DIR="$STATE" \
    BACKUP_OK_PATH="${TMP}/backup.ok" \
    BACKUP_DEBOUNCE_SEC=1 \
    BACKUP_INTERVAL_SEC=1 \
    BACKUP_VERIFY_SEC="$1" \
    BACKUP_RETRY_SEC="$2" \
    BACKUP_HEARTBEAT_DEFER_SEC="${3:-3600}" \
    BACKUP_HISTORY_SEC="${4:-3600}" \
    "$(command -v bash)" "$BACKUP_WATCH" >>"${TMP}/watch.log" 2>&1 &
  WATCH_PID=$!
}

# Processes started by the watcher (env marker survives re-parenting).
leaked_pids() {
  local env_file pid
  for env_file in /proc/[0-9]*/environ; do
    pid="${env_file#/proc/}"
    pid="${pid%/environ}"
    [[ "$pid" == "$$" || "$pid" == "$BASHPID" ]] && continue
    if { tr '\0' '\n' <"$env_file"; } 2>/dev/null | grep -qx "BUDGET_TEST_MARK=${MARK}"; then
      echo "$pid"
    fi
  done
  pgrep -f "$BACKUP_WATCH" 2>/dev/null || true
  pgrep -f "inotifywait.*${SRC}" 2>/dev/null || true
}

assert_no_leaks() {
  local leaked
  sleep 0.5
  leaked="$(leaked_pids | sort -u | tr '\n' ' ')"
  if [[ -n "${leaked// /}" ]]; then
    die "leaked processes after watcher exit: ${leaked}($(ps -o pid=,args= -p "${leaked// /,}" 2>/dev/null | head -5 | tr '\n' ';'))"
  fi
}

# stop_watch: TERM must end the watcher promptly (exit 143) with no leftovers.
stop_watch() {
  local t0 rc=0
  t0="$(date +%s)"
  kill -TERM "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || rc=$?
  WATCH_PID=""
  (( $(date +%s) - t0 <= 3 )) || die "watcher took more than 3s to exit on SIGTERM"
  [[ "$rc" == "143" ]] || die "watcher exit status on SIGTERM: expected 143, got ${rc}"
  assert_no_leaks
}

# --- 1. startup forces a full round-trip ---
start_watch 3600 3600
wait_until 15 "initial sync" remote_chain_matches
wait_until 5 "initial marker" test -f "${TMP}/backup.ok"
sleep 1
baseline="$(calls)"
(( baseline >= 3 )) || die "initial sync should call rclone copy+lsjson+copyto (got ${baseline})"
grep -q -- "--files-from" "$ARGS_LOG" && die "startup must do a full (checking) blob copy, not files-from"
log "PASS startup round-trip (${baseline} rclone calls)"

# --- 2. idle: periodic ticks make zero remote calls but keep the marker fresh ---
rm -f "${TMP}/backup.ok"
sleep 4
[[ "$(calls)" == "$baseline" ]] || die "idle cycles made remote calls ($(calls) vs ${baseline})"
[[ -f "${TMP}/backup.ok" ]] || die "idle skip must refresh BACKUP_OK_PATH"
log "PASS idle = 0 remote calls over 4 periodic ticks; marker refreshed"

# --- 3. non-heartbeat chain-only append: uploaded promptly, no blob copy, no lsjson ---
before_copy="$(count_of copy)"
before_lsjson="$(count_of lsjson)"
memory_line >>"${SRC}/chain.jsonl"
wait_until 6 "non-heartbeat append uploaded promptly" remote_chain_matches
sleep 1
[[ "$(count_of copy)" == "$before_copy" ]] || die "unchanged blobs/ should not be re-copied"
[[ "$(count_of lsjson)" == "$before_lsjson" ]] || die "shrink guard must use the recorded size, not lsjson, outside verify cycles"
log "PASS non-heartbeat append uploads promptly; no blob copy, no lsjson"

# --- 4. new blob + append: only the new blob, via files-from with no listing ---
: >"$ARGS_LOG"
printf 'blob-b' >"${SRC}/blobs/bafyb"
memory_line >>"${SRC}/chain.jsonl"
wait_until 15 "blob + chain uploaded" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/bafyb" ]] || die "new blob missing on remote"
copy_line="$(grep '^copy ' "$ARGS_LOG" || true)"
[[ "$(printf "%s\n" "$copy_line" | grep -c .)" == "1" ]] || die "expected exactly one blob copy, got: ${copy_line}"
for flag in --files-from --no-traverse --no-check-dest; do
  [[ "$copy_line" == *" ${flag}"* ]] || die "new-blob copy must pass ${flag}: ${copy_line}"
done
grep -qx 'files-from\[copy\]: bafyb ' "$ARGS_LOG" || die "files-from list must contain only the new blob: $(grep files-from "$ARGS_LOG")"
grep -qE '^(ls|lsf|lsjson|lsl|size) ' "$ARGS_LOG" && die "new-blob cycle must not list the remote"
log "PASS new blob uploaded alone via --files-from --no-traverse --no-check-dest"

# --- 4a. osp-core atomic-write temp files (.tmp-*) are never fingerprinted or uploaded ---
before_tmp="$(calls)"
printf 'half-written' >"${SRC}/blobs/.tmp-inflight"
sleep 4
[[ "$(calls)" == "$before_tmp" ]] || die "a .tmp-* file in blobs/ must not trigger remote calls"
[[ -e "${REMOTE_DIR}/blobs/.tmp-inflight" ]] && die ".tmp-* file must never be uploaded"
rm -f "${SRC}/blobs/.tmp-inflight"
log "PASS .tmp-* atomic-write temp files ignored (no calls, never uploaded)"

# --- 4b. history/: at most one rollback point per BACKUP_HISTORY_SEC ---
[[ "$(history_count)" == "1" ]] || die "expected exactly 1 history snapshot inside the window, got $(history_count)"
[[ "$(grep -c -- '--backup-dir' "$ARGS_LOG" || true)" == "0" ]] || die "--backup-dir passed again inside BACKUP_HISTORY_SEC"
log "PASS history/ snapshot taken once per window"

# --- 4c. a non-append rewrite (in-place migrate / restore) always keeps a rollback point ---
: >"$ARGS_LOG"
pre_rewrite="${TMP}/pre-rewrite.jsonl"
cp "${SRC}/chain.jsonl" "$pre_rewrite"
sed 's/^{"seq":0}$/{"migrated":true,"seq":0}/' "$pre_rewrite" >"${TMP}/rewritten.jsonl"
cmp -s "$pre_rewrite" "${TMP}/rewritten.jsonl" && die "rewrite fixture did not change the chain"
mv "${TMP}/rewritten.jsonl" "${SRC}/chain.jsonl" # atomic, larger, not an append
wait_until 10 "rewritten chain uploaded" remote_chain_matches
[[ "$(history_count)" == "2" ]] || die "non-append rewrite inside BACKUP_HISTORY_SEC must snapshot the prior tip (history count $(history_count))"
newest_history="$(find "${REMOTE_DIR}/history" -type f -name chain.jsonl | LC_ALL=C sort | tail -n 1)"
cmp -s "$newest_history" "$pre_rewrite" || die "history snapshot must hold the pre-rewrite tip"
grep -q "not a pure append of the last upload" "${TMP}/watch.log" || die "non-append history snapshot not logged"
sleep 1
memory_line >>"${SRC}/chain.jsonl" # pure append inside the window → no new snapshot
wait_until 10 "append after rewrite uploaded" remote_chain_matches
[[ "$(grep -c -- '--backup-dir' "$ARGS_LOG" || true)" == "1" ]] || die "pure append after the rewrite must not snapshot again inside the window"
[[ "$(history_count)" == "2" ]] || die "pure append after the rewrite must not add a history snapshot"
log "PASS non-append rewrite always snapshots the prior tip; following append does not"

# --- 5. blob copy failure aborts before the chain step, then backs off ---
echo copy >"$FAIL_ON"
printf 'blob-c' >"${SRC}/blobs/bafyc"
memory_line >>"${SRC}/chain.jsonl"
wait_until 15 "failed blob copy attempted" grep -q "blob copy failed" "${TMP}/watch.log"
sleep 1
remote_chain_matches && die "chain must not upload after a failed blob copy"
after_fail="$(calls)"
sleep 4
[[ "$(calls)" == "$after_fail" ]] || die "unchanged failed cycle retried inside BACKUP_RETRY_SEC ($(calls) vs ${after_fail})"
log "PASS blob failure blocks chain upload; unchanged failure backs off"

# --- 6. a new append retries immediately and recovers ---
rm -f "$FAIL_ON"
memory_line >>"${SRC}/chain.jsonl"
wait_until 15 "recovery after new append" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/bafyc" ]] || die "blob from failed cycle missing after recovery"
log "PASS new append retries immediately after failure"

# --- 7. heartbeat-only appends are deferred (0 calls); a real record flushes them ---
sleep 1
hb_blob="$(fake_cid hb1)"
before_hb="$(calls)"
printf 'heartbeat-record-bytes' >"${SRC}/blobs/${hb_blob}"
heartbeat_line >>"${SRC}/chain.jsonl"
heartbeat_line >>"${SRC}/chain.jsonl"
rm -f "${TMP}/backup.ok"
sleep 4
[[ "$(calls)" == "$before_hb" ]] || die "heartbeat-only appends made remote calls inside the defer window ($(calls) vs ${before_hb})"
remote_chain_matches && die "heartbeat-only append must not upload inside the defer window"
[[ -f "${TMP}/backup.ok" ]] || die "deferral must keep BACKUP_OK_PATH fresh"
grep -q "Deferring heartbeat-only change" "${TMP}/watch.log" || die "deferral not logged"
memory_line >>"${SRC}/chain.jsonl"
wait_until 6 "non-heartbeat append flushes deferred heartbeats" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/${hb_blob}" ]] || die "deferred heartbeat blob missing after flush"
log "PASS heartbeat-only appends deferred (0 calls, marker fresh); next real record uploads all"

# --- 8. blob fingerprint is a set identity (same count + total size, new name) ---
sleep 1
mv "${SRC}/blobs/bafyb" "${SRC}/blobs/bafyz"
memory_line >>"${SRC}/chain.jsonl"
wait_until 10 "renamed blob uploaded with chain" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/bafyz" ]] || die "same count+size blob set change was not detected (bafyz missing)"
[[ -f "${REMOTE_DIR}/blobs/bafyb" ]] || die "remote blob must never be removed by a local rename"
log "PASS set-identity fingerprint detects same count+size rename"

# --- 9. erasure: tombstone deletes exactly the tombstoned remote blob ---
erase_cid="$(fake_cid erase-me)"
keep_cid="$(fake_cid keep-me)"
record_cid="$(fake_cid record-blob)"
printf 'shard text to erase' >"${SRC}/blobs/${erase_cid}"
printf 'shard text to keep!' >"${SRC}/blobs/${keep_cid}"
printf 'record canonical bytes' >"${SRC}/blobs/${record_cid}"
memory_line "$record_cid" >>"${SRC}/chain.jsonl" # record_cid is a chain record ("prev")
wait_until 10 "erasure fixtures uploaded" remote_chain_matches
for c in "$erase_cid" "$keep_cid" "$record_cid"; do
  [[ -f "${REMOTE_DIR}/blobs/${c}" ]] || die "fixture blob ${c} not uploaded"
done
sleep 1
: >"$ARGS_LOG"
rm -f "${SRC}/blobs/${erase_cid}"
{
  tombstone_line "$erase_cid"
  tombstone_line "$keep_cid" "free text reason" # malformed → ignored
  tombstone_line "$record_cid"                  # record CID → refused
} >>"${SRC}/chain.jsonl"
wait_until 10 "tombstoned blob deleted remotely" test ! -e "${REMOTE_DIR}/blobs/${erase_cid}"
wait_until 5 "tombstone chain uploaded" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/${keep_cid}" ]] || die "malformed tombstone must not delete its blob"
[[ -f "${REMOTE_DIR}/blobs/${record_cid}" ]] || die "a chain record CID must never be deleted"
[[ -f "${REMOTE_DIR}/blobs/bafya" ]] || die "erasure deleted an unrelated blob"
grep -qx "files-from\[delete\]: ${erase_cid} " "$ARGS_LOG" || die "delete list must be exactly the tombstoned CID: $(grep 'files-from\[delete' "$ARGS_LOG")"
grep -n '^delete ' "$ARGS_LOG" | head -1 | grep -q -- '--files-from' || die "delete must be scoped by --files-from"
del_line="$(grep -n '^delete ' "$ARGS_LOG" | head -1 | cut -d: -f1)"
chain_line="$(grep -n '^copyto ' "$ARGS_LOG" | head -1 | cut -d: -f1)"
(( chain_line < del_line )) || die "erasure delete must run after the tombstone-bearing chain upload"
grep -q "did not match the strict shape" "${TMP}/watch.log" || die "malformed tombstone not reported"
grep -q "is a chain record CID; refusing" "${TMP}/watch.log" || die "record-CID tombstone not refused"
log "PASS tombstone deletes exactly the tombstoned blob (malformed/record-CID refused)"

# --- 9b. identical prose re-appended (same CID, records.md rule 12) uploads again ---
sleep 1
: >"$ARGS_LOG"
printf 'shard text to erase' >"${SRC}/blobs/${erase_cid}" # same content → same CID
memory_line >>"${SRC}/chain.jsonl"                       # does NOT reference it
wait_until 10 "unrelated append uploaded" remote_chain_matches
sleep 1
[[ -e "${REMOTE_DIR}/blobs/${erase_cid}" ]] && die "a tombstoned blob that no later record references must not be re-uploaded"
grep -q "files-from\[copy\]:.*${erase_cid}" "$ARGS_LOG" && die "tombstoned, unreferenced blob was sent to the remote"
memory_text_line "$erase_cid" >>"${SRC}/chain.jsonl" # referenced again after its tombstone
wait_until 10 "re-referenced blob uploaded" test -f "${REMOTE_DIR}/blobs/${erase_cid}"
wait_until 5 "re-reference chain uploaded" remote_chain_matches
grep -qx "$erase_cid" "${STATE}/erase.done" && die "revived CID must leave erase.done"
grep -q '^delete ' "$ARGS_LOG" && die "revival must not trigger a remote delete"
log "PASS re-appended identical blob (same CID) uploads once referenced again; unreferenced stays excluded"

# --- 10. concurrent cycles are serialized (periodic vs debounced) ---
: >"$OVERLAP"
touch "$SLOW"
before_conc="$(calls)"
for i in 1 2 3 4 5 6; do
  printf 'conc-%s' "$i" >"${SRC}/blobs/bafyconc${i}"
  memory_line >>"${SRC}/chain.jsonl"
  sleep 0.7
done
wait_until 30 "concurrent appends uploaded" remote_chain_matches
(( $(calls) - before_conc >= 4 )) || die "expected several slow cycles to run (got $(( $(calls) - before_conc )) calls)"
[[ ! -s "$OVERLAP" ]] || die "rclone calls overlapped (cycles not serialized): $(head -3 "$OVERLAP")"
log "PASS concurrent periodic/debounced cycles serialized ($(( $(calls) - before_conc )) slow calls, no overlap)"

# --- 11. SIGTERM mid-upload: prompt exit 143, no leaked children ---
memory_line >>"${SRC}/chain.jsonl"
wait_until 10 "slow upload in flight" test -d "${TMP}/inflight"
stop_watch
rm -f "$SLOW"
rmdir "${TMP}/inflight" 2>/dev/null || true
log "PASS SIGTERM mid-upload exits 143 within 3s; no leaked processes"

# --- 12. verify window forces a full round-trip even when idle ---
: >"$CALLS"
: >"$ARGS_LOG"
start_watch 2 3600
wait_until 15 "restart sync" calls_above 2
sleep 1
restart_calls="$(calls)"
wait_until 15 "verify round-trip" calls_above "$restart_calls"
lsjson_at_least() { (( $(count_of lsjson) >= $1 )); }
wait_until 5 "verify cycle lsjson" lsjson_at_least 2
log "PASS idle verify window forces a full remote round-trip"
stop_watch
[[ -f "${REMOTE_DIR}/blobs/${erase_cid}" ]] || die "full rescan deleted a blob referenced again after its tombstone"
[[ "$(count_of delete)" == "0" ]] || die "full rescan re-issued a delete for a revived blob"
log "PASS full rescans keep the revived blob (no delete)"

# --- 13. a deferral never outlives BACKUP_HEARTBEAT_DEFER_SEC (periodic flush) ---
last_log_has() { tail -n 3 "${TMP}/watch.log" | grep -q "$1"; }
: >"$CALLS"
start_watch 3600 3600 8 3600
wait_until 15 "restart sync (defer phase)" remote_chain_matches
wait_until 5 "restart sync settled" last_log_has "Sync complete"
t_upload="$(date +%s)"
sleep 1
quiet="$(calls)"
heartbeat_line >>"${SRC}/chain.jsonl"
sleep 2
[[ "$(calls)" == "$quiet" ]] || die "heartbeat inside a fresh defer window made remote calls"
remote_chain_matches && die "heartbeat uploaded inside a fresh defer window"
wait_until 15 "deferred heartbeat flushed by the periodic tick" remote_chain_matches
t_flush="$(date +%s)"
(( t_flush - t_upload <= 8 + 2 )) || die "deferral exceeded the window: flushed $(( t_flush - t_upload ))s after the last upload (window 8s)"
log "PASS heartbeat deferral flushed by the periodic tick within the window ($(( t_flush - t_upload ))s, window 8s)"
stop_watch

# --- 14. a failing FULL cycle backs off too (no full copy + lsjson per tick) ---
full_copies() { grep '^copy ' "$ARGS_LOG" | grep -vc -- '--files-from' || true; }
full_copies_at_least() { (( $(full_copies) >= $1 )); }
: >"$CALLS"
: >"$ARGS_LOG"
: >"$FULL_TIMES"
echo copy-full >"$FAIL_ON"
start_watch 2 3600 # verify due every 2s; ticks every 1s
wait_until 15 "startup full copy attempted" full_copies_at_least 1
sleep 1
rm -f "${TMP}/backup.ok"
sleep 5
[[ "$(full_copies)" == "1" ]] || die "failed full cycle re-ran inside BACKUP_RETRY_SEC: $(full_copies) full copies"
[[ "$(count_of lsjson)" == "0" ]] || die "failed full cycle must not lsjson on every tick ($(count_of lsjson))"
[[ ! -f "${TMP}/backup.ok" ]] || die "marker refreshed while a full-cycle failure is outstanding"
memory_line >>"${SRC}/chain.jsonl"
wait_until 10 "incremental upload during full-cycle backoff" remote_chain_matches
sleep 2
[[ "$(full_copies)" == "1" ]] || die "debounced change ran a full cycle inside the backoff: $(full_copies) full copies"
[[ ! -f "${TMP}/backup.ok" ]] || die "incremental success must not refresh the marker while the full cycle is failing"
grep -q "Full cycle failed; next full attempt" "${TMP}/watch.log" || die "full-cycle backoff not logged"
log "PASS failed full cycle backs off: 1 full copy, 0 lsjson over 7+ ticks; incremental append still uploaded; marker stays stale"
stop_watch

# --- 14b. full retries are spaced >= BACKUP_RETRY_SEC; restart still does one full; success clears ---
: >"$ARGS_LOG"
: >"$FULL_TIMES"
start_watch 2 3
wait_until 15 "startup full copy despite outstanding backoff" full_copies_at_least 1
sleep 8
n_full="$(full_copies)"
(( n_full >= 2 && n_full <= 4 )) || die "expected 2-4 full attempts in ~9s with BACKUP_RETRY_SEC=3, got ${n_full}"
prev_t=""
while IFS= read -r t; do
  if [[ -n "$prev_t" ]] && (( t - prev_t < 3 )); then
    die "full attempts ${prev_t} -> ${t} closer than BACKUP_RETRY_SEC=3"
  fi
  prev_t="$t"
done <"$FULL_TIMES"
rm -f "$FAIL_ON"
wait_until 10 "full retry succeeds and refreshes the marker" test -f "${TMP}/backup.ok"
[[ ! -e "${STATE}/full.failed.at" ]] || die "successful full cycle must clear full.failed.at"
log "PASS full retries spaced >= BACKUP_RETRY_SEC (${n_full} in ~9s); success clears backoff and refreshes marker"
stop_watch

# --- 15. empty / temp-only blobs/ never ends the main loop (poll mode: set -e + pipefail) ---
SRC="${TMP}/soulchain-empty"
REMOTE_DIR="${TMP}/remote-empty"
STATE="${TMP}/state-empty"
mkdir -p "${SRC}/blobs" "$REMOTE_DIR"
printf '{"seq":0}\n' >"${SRC}/chain.jsonl"
start_watch 3600 3600
wait_until 15 "empty-blobs initial sync" remote_chain_matches
sleep 5
kill -0 "$WATCH_PID" 2>/dev/null || die "watcher exited with an empty blobs/"
printf 'half' >"${SRC}/blobs/.tmp-only"
sleep 5
kill -0 "$WATCH_PID" 2>/dev/null || die "watcher exited with only .tmp-* files in blobs/"
memory_line >>"${SRC}/chain.jsonl"
wait_until 10 "change detected after empty/temp-only blobs/" remote_chain_matches
printf 'real' >"${SRC}/blobs/bafyreal"
for i in $(seq 1 40); do # churn: temp files that vanish between readdir and stat
  printf 'x' >"${SRC}/blobs/.tmp-churn${i}"
  rm -f "${SRC}/blobs/.tmp-churn${i}"
  sleep 0.1
done
kill -0 "$WATCH_PID" 2>/dev/null || die "watcher exited during .tmp-* churn"
memory_line >>"${SRC}/chain.jsonl"
wait_until 10 "upload after temp churn" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/bafyreal" ]] || die "real blob not uploaded after temp churn"
[[ -z "$(find "${REMOTE_DIR}/blobs" -name '.tmp-*' 2>/dev/null)" ]] || die ".tmp-* file uploaded"
log "PASS empty and temp-only blobs/ keep the watcher alive; changes still detected"
stop_watch

log "All backup-watch budget checks passed (mode: ${MODE})"
