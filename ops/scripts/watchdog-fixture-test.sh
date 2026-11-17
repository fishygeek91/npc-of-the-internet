#!/usr/bin/env bash
# Offline proof for ops/scripts/watchdog.sh (T7.13).
# No network, no Docker daemon, no Discord. curl/docker/rclone on PATH are shims
# that record a call and fail the test if a dry-run touches them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCH="${SCRIPT_DIR}/watchdog.sh"
ORIG_PATH="${PATH}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/npc-watchdog-test.XXXXXX")"
PROBE_LOG="${TMP}/probe.log"
PROBE_STDIN="${TMP}/probe.stdin"
SHIM="${TMP}/bin"
CASE_OUT=""
CASE_ERR=""

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "[watchdog-fixture-test] FAIL: $*" >&2
  exit 1
}

mkdir -p "$SHIM"
: >"$PROBE_LOG"
: >"$PROBE_STDIN"

cat >"${SHIM}/curl" <<'EOF'
#!/bin/sh
# Argv goes to the probe log. The webhook arrives on stdin (curl -K -).
printf '%s\n' "$*" >> "${PROBE_LOG:?}"
if [ -n "${PROBE_STDIN:-}" ]; then
  cat >> "${PROBE_STDIN}"
else
  cat >/dev/null
fi
if [ "${CURL_FAIL:-}" = "1" ]; then
  exit 1
fi
exit 0
EOF
cat >"${SHIM}/docker" <<'EOF'
#!/bin/sh
echo "docker invoked" >> "${PROBE_LOG:?}"
exit 99
EOF
cat >"${SHIM}/rclone" <<'EOF'
#!/bin/sh
echo "rclone invoked" >> "${PROBE_LOG:?}"
exit 99
EOF
chmod +x "${SHIM}/curl" "${SHIM}/docker" "${SHIM}/rclone"

# Hermetic env: a developer shell must not leak a real webhook into a case.
run_case() {
  local name="$1"
  local expect_rc="$2"
  shift 2
  : >"$PROBE_LOG"
  : >"$PROBE_STDIN"
  local out="${TMP}/${name}.out"
  local err="${TMP}/${name}.err"
  set +e
  env -i \
    PATH="${SHIM}:${ORIG_PATH}" \
    HOME="${HOME}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PROBE_LOG="${PROBE_LOG}" \
    PROBE_STDIN="${PROBE_STDIN}" \
    "$@" >"$out" 2>"$err"
  local rc=$?
  set -e
  if [[ "$rc" -ne "$expect_rc" ]]; then
    echo "--- stdout ---" >&2
    cat "$out" >&2
    echo "--- stderr ---" >&2
    cat "$err" >&2
    fail "${name}: exit ${rc}, expected ${expect_rc}"
  fi
  CASE_OUT="$out"
  CASE_ERR="$err"
}

assert_grep() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if ! grep -q -e "$pattern" "$file"; then
    echo "--- ${file} ---" >&2
    cat "$file" >&2
    fail "$message"
  fi
}

assert_no_grep() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if grep -q -e "$pattern" "$file"; then
    echo "--- ${file} ---" >&2
    cat "$file" >&2
    fail "$message"
  fi
}

assert_quiet_probes() {
  local message="$1"
  if [[ -s "$PROBE_LOG" ]]; then
    echo "--- probe log ---" >&2
    cat "$PROBE_LOG" >&2
    fail "$message"
  fi
}

# Healthy and failing probe files. Epochs are injected so the test does not
# depend on touch(1) timestamp flags.
PS_OK="${TMP}/ps-ok.txt"
PS_BAD="${TMP}/ps-bad.txt"
DF_OK="${TMP}/df-ok.txt"
DF_BAD="${TMP}/df-bad.txt"
MEM_OK="${TMP}/mem-ok.txt"
MEM_BAD="${TMP}/mem-bad.txt"
CHAIN="${TMP}/chain.jsonl"
MARKER="${TMP}/backup.ok"
WEBHOOK="https://discord.com/api/webhooks/1234567890/fixturetoken"
APP_WEBHOOK="https://discordapp.com/api/webhooks/1234567890/fixturetoken"
HTTP_WEBHOOK="http://discord.com/api/webhooks/1234567890/fixturetoken"
cat >"$PS_OK" <<'EOF'
runtime healthy
door-discord healthy
door-web healthy
atlas-api healthy
backup healthy
EOF
cat >"$PS_BAD" <<'EOF'
runtime unhealthy
door-discord healthy
EOF
printf '%s\n' "Filesystem 1024-blocks Used Available Capacity Mounted on" "root 99999999 1000 99999999 1% /" >"$DF_OK"
printf '%s\n' "Filesystem 1024-blocks Used Available Capacity Mounted on" "root 99999999 1000 1024 99% /" >"$DF_BAD"
printf '%s\n' "MemTotal: 8000000 kB" "MemAvailable: 8000000 kB" >"$MEM_OK"
printf '%s\n' "MemTotal: 8000000 kB" "MemAvailable: 1000 kB" >"$MEM_BAD"
: >"$CHAIN"
: >"$MARKER"

echo "[watchdog-fixture-test] bare dry-run"
run_case bare 0 bash "$WATCH"
assert_grep "$CASE_OUT" "^\[watchdog\] mode=dry-run$" "bare mode"
assert_grep "$CASE_OUT" "^INFO containers " "bare containers skip"
assert_grep "$CASE_OUT" "^INFO backup_marker " "bare backup skip"
assert_grep "$CASE_OUT" "^INFO chain_mtime " "bare chain skip"
assert_grep "$CASE_OUT" "^INFO disk " "bare disk skip"
assert_grep "$CASE_OUT" "^INFO memory " "bare memory skip"
assert_grep "$CASE_OUT" "no alerts; Discord not contacted" "bare discord"
assert_no_grep "$CASE_OUT" "^ALERT " "bare alerted"
assert_quiet_probes "bare dry-run invoked curl, docker, or rclone"

echo "[watchdog-fixture-test] healthy probes"
run_case healthy 0 \
  NPC_WATCHDOG_PS_FILE="$PS_OK" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
for check in containers backup_marker chain_mtime disk memory; do
  assert_grep "$CASE_OUT" "^OK ${check} " "healthy missing ${check}"
done
assert_no_grep "$CASE_OUT" "^ALERT " "healthy alerted"
assert_grep "$CASE_OUT" "no alerts; Discord not contacted" "healthy discord"
assert_quiet_probes "healthy dry-run invoked a probe command"

echo "[watchdog-fixture-test] failing probes stay local"
run_case failing 1 \
  DISCORD_OPERATOR_WEBHOOK="$WEBHOOK" \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=1000 \
  NPC_WATCHDOG_NOW_EPOCH=10000 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=1000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=100000 \
  NPC_WATCHDOG_DF_FILE="$DF_BAD" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_BAD" \
  bash "$WATCH"
for check in containers backup_marker chain_mtime disk memory; do
  assert_grep "$CASE_OUT" "^ALERT ${check} " "failing missing ${check}"
done
assert_grep "$CASE_OUT" "consult: ops/RUNBOOK.md#3-logs-and-health" "containers consult"
assert_grep "$CASE_OUT" "consult: ops/RUNBOOK.md#35-backup-activity" "backup consult"
assert_grep "$CASE_OUT" "consult: ops/RUNBOOK.md#52-production-restore" "chain consult"
assert_grep "$CASE_OUT" "consult: ops/RUNBOOK.ghost.md#10-routine-operations" "disk consult"
assert_grep "$CASE_OUT" "consult: ops/RUNBOOK.ghost.md#11-if-something-goes-wrong" "memory consult"
assert_grep "$CASE_OUT" "dry-run: Discord not contacted" "failing posted"
assert_grep "$CASE_OUT" "Do not delete the remote" "failing action hint"
assert_no_grep "$CASE_OUT" "fixturetoken" "failing stdout leaked the webhook"
assert_no_grep "$CASE_ERR" "fixturetoken" "failing stderr leaked the webhook"
assert_quiet_probes "dry-run with a webhook still invoked curl"

echo "[watchdog-fixture-test] missing marker"
run_case missing_marker 1 \
  BACKUP_OK_PATH="${TMP}/no-such-marker" \
  NPC_WATCHDOG_PS_FILE="$PS_OK" \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "^ALERT backup_marker " "missing marker did not alert"
assert_quiet_probes "missing-marker case invoked a probe command"

echo "[watchdog-fixture-test] live post uses the shim and hides the webhook"
run_case live_post 1 \
  NPC_WATCHDOG_LIVE=1 \
  DISCORD_OPERATOR_WEBHOOK="$WEBHOOK" \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "^\[watchdog\] mode=live$" "live mode"
assert_grep "$CASE_OUT" "live: posted .* alert" "live did not report a post"
assert_grep "$PROBE_STDIN" "fixturetoken" "live curl did not receive the url on stdin"
assert_grep "$PROBE_LOG" "\-\-proto" "live curl dropped --proto"
assert_grep "$PROBE_LOG" "\-K" "live curl did not read a config file"
assert_no_grep "$PROBE_LOG" "fixturetoken" "live curl argv contained the webhook"
assert_grep "$PROBE_LOG" "consult: ops/RUNBOOK.md#3-logs-and-health" "live payload missed the runbook"
assert_no_grep "$CASE_OUT" "fixturetoken" "live stdout leaked the webhook"
assert_no_grep "$CASE_ERR" "fixturetoken" "live stderr leaked the webhook"
assert_no_grep "$PROBE_LOG" "docker invoked" "live post called docker"
assert_no_grep "$PROBE_LOG" "rclone invoked" "live post called rclone"

echo "[watchdog-fixture-test] live and healthy does not post"
run_case live_quiet 0 \
  NPC_WATCHDOG_LIVE=1 \
  DISCORD_OPERATOR_WEBHOOK="$WEBHOOK" \
  NPC_WATCHDOG_PS_FILE="$PS_OK" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "no alerts; Discord not contacted" "healthy live contacted Discord"
assert_quiet_probes "healthy live invoked curl"

echo "[watchdog-fixture-test] live without a webhook is a config error"
run_case live_nowebhook 2 \
  NPC_WATCHDOG_LIVE=1 \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_ERR" "Not posting" "missing webhook stderr"
assert_quiet_probes "missing webhook still invoked curl"

echo "[watchdog-fixture-test] non-Discord URL is refused"
run_case live_badurl 2 \
  NPC_WATCHDOG_LIVE=1 \
  DISCORD_OPERATOR_WEBHOOK="https://evil.example/api/webhooks/1234567890/fixturetoken" \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_ERR" "Not posting" "bad url stderr"
assert_no_grep "$CASE_OUT" "fixturetoken" "bad url stdout leaked the webhook"
assert_no_grep "$CASE_ERR" "fixturetoken" "bad url stderr leaked the webhook"
assert_quiet_probes "bad url invoked curl"

echo "[watchdog-fixture-test] LIVE=true is not live"
run_case live_true 1 \
  NPC_WATCHDOG_LIVE=true \
  DISCORD_OPERATOR_WEBHOOK="$WEBHOOK" \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "^\[watchdog\] mode=dry-run$" "true was treated as live"
assert_quiet_probes "LIVE=true invoked curl"

echo "[watchdog-fixture-test] live ghostc ps failure does not escape the shim"
run_case live_ps 1 \
  NPC_WATCHDOG_LIVE=1 \
  DISCORD_OPERATOR_WEBHOOK="$WEBHOOK" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "^ALERT containers " "ghostc failure did not alert"
assert_grep "$PROBE_LOG" "docker invoked" "ghostc did not call docker"
assert_no_grep "$PROBE_LOG" "rclone invoked" "ghostc failure called rclone"
assert_grep "$PROBE_STDIN" "fixturetoken" "ghostc failure did not page via stdin"
assert_no_grep "$PROBE_LOG" "fixturetoken" "ghostc failure put the webhook in argv"
assert_no_grep "$CASE_OUT" "fixturetoken" "ghostc failure stdout leaked the webhook"
assert_no_grep "$CASE_ERR" "fixturetoken" "ghostc failure stderr leaked the webhook"

echo "[watchdog-fixture-test] marker mtime comes from stat"
run_case real_mtime 0 \
  NPC_WATCHDOG_PS_FILE="$PS_OK" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "^OK backup_marker " "stat mtime was not treated as fresh"
assert_quiet_probes "stat case invoked a probe command"

echo "[watchdog-fixture-test] probe text is not shell"
inject_ps="${TMP}/ps-inject.txt"
printf '%s\n' "runtime \$(touch ${TMP}/pwned)" >"$inject_ps"
rm -f "${TMP}/pwned"
run_case inject 1 \
  NPC_WATCHDOG_PS_FILE="$inject_ps" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
[[ ! -e "${TMP}/pwned" ]] || fail "probe text was evaluated as shell"
assert_grep "$CASE_OUT" "^ALERT containers " "inject did not alert"
assert_quiet_probes "inject case invoked a probe command"

echo "[watchdog-fixture-test] curl failure stays local and hides the webhook"
run_case live_curl_fail 1 \
  NPC_WATCHDOG_LIVE=1 \
  CURL_FAIL=1 \
  DISCORD_OPERATOR_WEBHOOK="$WEBHOOK" \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_ERR" "Discord POST failed" "curl failure stderr"
assert_no_grep "$CASE_OUT" "fixturetoken" "curl failure stdout leaked the webhook"
assert_no_grep "$CASE_ERR" "fixturetoken" "curl failure stderr leaked the webhook"
assert_no_grep "$PROBE_LOG" "fixturetoken" "curl failure argv contained the webhook"
assert_grep "$PROBE_STDIN" "fixturetoken" "curl failure did not pass the url on stdin"

echo "[watchdog-fixture-test] http webhook is refused before curl"
run_case live_http 2 \
  NPC_WATCHDOG_LIVE=1 \
  DISCORD_OPERATOR_WEBHOOK="$HTTP_WEBHOOK" \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_ERR" "Not posting" "http webhook stderr"
assert_no_grep "$CASE_OUT" "fixturetoken" "http webhook stdout leaked the token"
assert_no_grep "$CASE_ERR" "fixturetoken" "http webhook stderr leaked the token"
assert_quiet_probes "http webhook invoked curl"

echo "[watchdog-fixture-test] discordapp.com webhook is accepted"
run_case live_discordapp 1 \
  NPC_WATCHDOG_LIVE=1 \
  DISCORD_OPERATOR_WEBHOOK="$APP_WEBHOOK" \
  NPC_WATCHDOG_PS_FILE="$PS_BAD" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "live: posted .* alert" "discordapp.com was not accepted"
assert_grep "$PROBE_STDIN" "discordapp.com" "discordapp.com url was not on stdin"
assert_no_grep "$PROBE_LOG" "fixturetoken" "discordapp.com url leaked into argv"
assert_no_grep "$CASE_OUT" "fixturetoken" "discordapp.com stdout leaked the token"
assert_no_grep "$CASE_ERR" "fixturetoken" "discordapp.com stderr leaked the token"

echo "[watchdog-fixture-test] leading zero is an alert, not an octal crash"
run_case leading_zero 1 \
  NPC_WATCHDOG_PS_FILE="$PS_OK" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_DISK_MIN_FREE_MB=08 \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_OUT" "^ALERT disk " "leading zero did not alert"
assert_grep "$CASE_OUT" "^OK memory " "leading zero aborted later checks"
assert_no_grep "$CASE_ERR" "value too great for base" "leading zero was parsed as octal"
assert_quiet_probes "leading zero invoked a probe command"

echo "[watchdog-fixture-test] healthy live run without a webhook exits 2"
run_case live_healthy_nowebhook 2 \
  NPC_WATCHDOG_LIVE=1 \
  NPC_WATCHDOG_PS_FILE="$PS_OK" \
  BACKUP_OK_PATH="$MARKER" \
  NPC_WATCHDOG_BACKUP_MTIME=10000 \
  NPC_WATCHDOG_NOW_EPOCH=10100 \
  NPC_WATCHDOG_LOCAL_CHAIN="$CHAIN" \
  NPC_WATCHDOG_LOCAL_CHAIN_EPOCH=10000 \
  NPC_WATCHDOG_REMOTE_CHAIN_EPOCH=10050 \
  NPC_WATCHDOG_DF_FILE="$DF_OK" \
  NPC_WATCHDOG_MEMINFO_FILE="$MEM_OK" \
  bash "$WATCH"
assert_grep "$CASE_ERR" "Not posting" "healthy live missing webhook stderr"
assert_no_grep "$CASE_OUT" "^OK " "healthy live missing webhook still ran checks"
assert_no_grep "$CASE_OUT" "^ALERT " "healthy live missing webhook alerted"
assert_quiet_probes "healthy live missing webhook invoked curl"

echo "[watchdog-fixture-test] arguments are refused"
run_case args 2 bash "$WATCH" --i-have-gate-2-approval
assert_grep "$CASE_ERR" "no arguments expected" "args stderr"
assert_quiet_probes "args invoked a probe command"

echo "[watchdog-fixture-test] ok"
