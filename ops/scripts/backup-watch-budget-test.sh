#!/usr/bin/env bash
# Offline test: backup-watch.sh makes remote (rclone) calls only when the local
# soulchain changed, the verify window elapsed, or a failed cycle's backoff expired.
# Regression guard for the 2026-10-04 B2 Class C cap exhaustion (idle sidecar made
# ~2,500 list/auth calls/day). No network: uses an rclone local-filesystem remote
# and a PATH shim that counts rclone subcommands.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_WATCH="${SCRIPT_DIR}/backup-watch.sh"
REAL_RCLONE="$(command -v rclone || true)"

log() { echo "[backup-budget-test] $*"; }
die() { echo "[backup-budget-test] FAIL: $*" >&2; exit 1; }

[[ -n "$REAL_RCLONE" ]] || die "rclone not found on PATH"

TMP="$(mktemp -d)"
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
FAIL_ON="${TMP}/fail-on"
mkdir -p "${SRC}/blobs" "$REMOTE_DIR" "$SHIM"
: >"$CALLS"

cat >"${TMP}/rclone.conf" <<EOF
[testlocal]
type = local
EOF

# Shim: record each subcommand; fail it when listed in $FAIL_ON. lsjson on a
# missing object mimics bucket remotes (B2/S3): exit 0 with an empty multi-line
# array, as rclone does there (the local backend would exit 3 instead).
cat >"${SHIM}/rclone" <<EOF
#!/usr/bin/env bash
echo "\$1" >>"${CALLS}"
if [[ -f "${FAIL_ON}" ]] && grep -qx "\$1" "${FAIL_ON}"; then
  exit 1
fi
if [[ "\$1" == "lsjson" && ! -e "\${2#testlocal:}" ]]; then
  printf '[\n]\n'
  exit 0
fi
exec "${REAL_RCLONE}" "\$@"
EOF
chmod +x "${SHIM}/rclone"

calls() { wc -l <"$CALLS" | tr -d ' '; }
count_of() { grep -cx "$1" "$CALLS" || true; }
calls_above() { (( $(calls) > $1 )); }

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

printf '{"seq":0}\n' >"${SRC}/chain.jsonl"
printf 'blob-a' >"${SRC}/blobs/bafya"

start_watch() {
  PATH="${SHIM}:${PATH}" \
    BACKUP_SOURCE_DIR="$SRC" \
    BACKUP_RCLONE_REMOTE="testlocal:${REMOTE_DIR}" \
    RCLONE_CONFIG="${TMP}/rclone.conf" \
    BACKUP_STATE_DIR="${TMP}/state" \
    BACKUP_OK_PATH="${TMP}/backup.ok" \
    BACKUP_DEBOUNCE_SEC=1 \
    BACKUP_INTERVAL_SEC=1 \
    BACKUP_VERIFY_SEC="$1" \
    BACKUP_RETRY_SEC="$2" \
    bash "$BACKUP_WATCH" >>"${TMP}/watch.log" 2>&1 &
  WATCH_PID=$!
}

stop_watch() {
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
  WATCH_PID=""
}

# --- 1. startup forces a full round-trip ---
start_watch 3600 3600
wait_until 15 "initial sync" remote_chain_matches
wait_until 5 "initial marker" test -f "${TMP}/backup.ok"
sleep 1
baseline="$(calls)"
(( baseline >= 3 )) || die "initial sync should call rclone copy+lsjson+copyto (got ${baseline})"
log "PASS startup round-trip (${baseline} rclone calls)"

# --- 2. idle: periodic ticks make zero remote calls but keep the marker fresh ---
rm -f "${TMP}/backup.ok"
sleep 4
[[ "$(calls)" == "$baseline" ]] || die "idle cycles made remote calls ($(calls) vs ${baseline}); log: $(tail -5 "${TMP}/watch.log")"
[[ -f "${TMP}/backup.ok" ]] || die "idle skip must refresh BACKUP_OK_PATH"
log "PASS idle = 0 remote calls over 4 periodic ticks; marker refreshed"

# --- 3. chain-only append: chain uploaded, blob copy skipped ---
before_copy="$(count_of copy)"
printf '{"seq":1}\n' >>"${SRC}/chain.jsonl"
wait_until 15 "chain append uploaded" remote_chain_matches
sleep 1
[[ "$(count_of copy)" == "$before_copy" ]] || die "unchanged blobs/ should not be re-copied"
log "PASS chain-only append uploads chain without blob copy"

# --- 4. new blob + append: blobs copied before chain ---
printf 'blob-b' >"${SRC}/blobs/bafyb"
printf '{"seq":2}\n' >>"${SRC}/chain.jsonl"
wait_until 15 "blob + chain uploaded" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/bafyb" ]] || die "new blob missing on remote"
log "PASS new blob + append uploaded"

# --- 5. blob copy failure aborts before the chain step, then backs off ---
echo copy >"$FAIL_ON"
printf 'blob-c' >"${SRC}/blobs/bafyc"
printf '{"seq":3}\n' >>"${SRC}/chain.jsonl"
wait_until 15 "failed blob copy attempted" grep -q "blob copy failed" "${TMP}/watch.log"
sleep 1
remote_chain_matches && die "chain must not upload after a failed blob copy"
after_fail="$(calls)"
sleep 4
[[ "$(calls)" == "$after_fail" ]] || die "unchanged failed cycle retried inside BACKUP_RETRY_SEC ($(calls) vs ${after_fail})"
log "PASS blob failure blocks chain upload; unchanged failure backs off"

# --- 6. a new append retries immediately and recovers ---
rm -f "$FAIL_ON"
printf '{"seq":4}\n' >>"${SRC}/chain.jsonl"
wait_until 15 "recovery after new append" remote_chain_matches
[[ -f "${REMOTE_DIR}/blobs/bafyc" ]] || die "blob from failed cycle missing after recovery"
log "PASS new append retries immediately after failure"
stop_watch

# --- 7. verify window forces a round-trip even when idle ---
: >"$CALLS"
start_watch 2 3600
wait_until 15 "restart sync" calls_above 2
sleep 1
restart_calls="$(calls)"
wait_until 15 "verify round-trip" calls_above "$restart_calls"
log "PASS idle verify window forces a remote round-trip"
stop_watch

log "All backup-watch budget checks passed"
