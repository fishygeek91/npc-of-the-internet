#!/usr/bin/env bash
# Linux bind-mount uid/gid check for Ghost images (#84).
# Asserts container npc is 10001:10001, wrong-owned host secrets are unreadable,
# and correctly-owned secrets are readable. Must run on Linux (not macOS Docker Desktop).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NPC_UID=10001
NPC_GID=10001
WRONG_UID=1000
WRONG_GID=1000

RUNTIME_IMAGE="npc-uid-check-runtime:local"
BACKUP_IMAGE="npc-uid-check-backup:local"

WORK_TMP=""

cleanup() {
  if [[ -n "$WORK_TMP" && -d "$WORK_TMP" ]]; then
    # Files may be owned by 10001 / 1000 — need elevated removal.
    sudo rm -rf "$WORK_TMP" 2>/dev/null || rm -rf "$WORK_TMP" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() {
  echo "[uid-mount-check] $*"
}

die() {
  echo "[uid-mount-check] ERROR: $*" >&2
  exit 1
}

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    die "${label}: expected '${expected}', got '${actual}'"
  fi
  log "OK ${label}=${actual}"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  die "this check requires Linux bind-mount semantics (got $(uname -s)); run in CI or on a Linux host"
fi

if ! command -v docker >/dev/null 2>&1; then
  die "docker not found on PATH"
fi

if ! command -v sudo >/dev/null 2>&1; then
  die "sudo not found on PATH (needed to chown fixture files to ${NPC_UID}/${WRONG_UID})"
fi

WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/uid-mount-check.XXXXXX")"
KEYS_WRONG="${WORK_TMP}/wrong/keys"
KEYS_RIGHT="${WORK_TMP}/right/keys"
RCLONE_WRONG="${WORK_TMP}/wrong/rclone"
RCLONE_RIGHT="${WORK_TMP}/right/rclone"

mkdir -p "$KEYS_WRONG" "$KEYS_RIGHT" "$RCLONE_WRONG" "$RCLONE_RIGHT"

# Throwaway fixture bytes only — never real key material.
printf 'uid-mount-check-fixture-key-bytes!!!!' > "${KEYS_WRONG}/soul.key"
printf 'uid-mount-check-fixture-key-bytes!!!!' > "${KEYS_RIGHT}/soul.key"
printf '# uid-mount-check fixture rclone.conf\n' > "${RCLONE_WRONG}/rclone.conf"
printf '# uid-mount-check fixture rclone.conf\n' > "${RCLONE_RIGHT}/rclone.conf"

sudo chown -R "${WRONG_UID}:${WRONG_GID}" "${WORK_TMP}/wrong"
sudo chown -R "${NPC_UID}:${NPC_GID}" "${WORK_TMP}/right"
sudo chmod 700 "$KEYS_WRONG" "$KEYS_RIGHT" "$RCLONE_WRONG" "$RCLONE_RIGHT"
sudo chmod 600 \
  "${KEYS_WRONG}/soul.key" \
  "${KEYS_RIGHT}/soul.key" \
  "${RCLONE_WRONG}/rclone.conf" \
  "${RCLONE_RIGHT}/rclone.conf"

log "Building runtime image (${RUNTIME_IMAGE})..."
docker build -f "${REPO_ROOT}/ops/Dockerfile.runtime" -t "$RUNTIME_IMAGE" "$REPO_ROOT"

log "Building backup image (${BACKUP_IMAGE})..."
docker build -f "${REPO_ROOT}/ops/Dockerfile.backup" -t "$BACKUP_IMAGE" "$REPO_ROOT"

log "Asserting image users are ${NPC_UID}:${NPC_GID}"
RUNTIME_ID="$(docker run --rm --entrypoint id "$RUNTIME_IMAGE" -u)"
RUNTIME_GID="$(docker run --rm --entrypoint id "$RUNTIME_IMAGE" -g)"
BACKUP_ID="$(docker run --rm --entrypoint id "$BACKUP_IMAGE" -u)"
BACKUP_GID="$(docker run --rm --entrypoint id "$BACKUP_IMAGE" -g)"
assert_eq "runtime uid" "$NPC_UID" "$RUNTIME_ID"
assert_eq "runtime gid" "$NPC_GID" "$RUNTIME_GID"
assert_eq "backup uid" "$NPC_UID" "$BACKUP_ID"
assert_eq "backup gid" "$NPC_GID" "$BACKUP_GID"

log "Wrong ownership (uid ${WRONG_UID}): key mount must be unreadable"
set +e
WRONG_KEY_OUT="$(
  docker run --rm \
    --entrypoint sh \
    -v "${KEYS_WRONG}/soul.key:/run/keys/soul.key:ro" \
    "$RUNTIME_IMAGE" \
    -c 'cat /run/keys/soul.key > /dev/null' 2>&1
)"
WRONG_KEY_RC=$?
set -e
if [[ "$WRONG_KEY_RC" -eq 0 ]]; then
  die "expected unreadable wrong-owned soul.key inside runtime, but cat succeeded:\n${WRONG_KEY_OUT}"
fi
log "OK wrong-owned key rejected (exit ${WRONG_KEY_RC})"

log "Correct ownership (uid ${NPC_UID}): key mount must be readable"
docker run --rm \
  --entrypoint sh \
  -v "${KEYS_RIGHT}/soul.key:/run/keys/soul.key:ro" \
  "$RUNTIME_IMAGE" \
  -c 'cat /run/keys/soul.key > /dev/null'
log "OK correctly-owned key readable"

log "Wrong ownership: backup must exit loudly when rclone.conf is unreadable"
set +e
WRONG_BACKUP_OUT="$(
  docker run --rm \
    -e BACKUP_RCLONE_REMOTE="ghost-remote:npc/soulchain" \
    -e RCLONE_CONFIG="/config/rclone/rclone.conf" \
    -v "${RCLONE_WRONG}:/config/rclone:ro" \
    "$BACKUP_IMAGE" 2>&1
)"
WRONG_BACKUP_RC=$?
set -e
if [[ "$WRONG_BACKUP_RC" -eq 0 ]]; then
  die "expected backup to exit non-zero on unreadable rclone.conf"
fi
if ! printf '%s\n' "$WRONG_BACKUP_OUT" | grep -q "permissions"; then
  die "backup stderr missing 'permissions' hint; output was:\n${WRONG_BACKUP_OUT}"
fi
log "OK backup fail-fast on unreadable rclone.conf (exit ${WRONG_BACKUP_RC})"

log "Correct ownership: backup must pass the rclone.conf readability guard"
mkdir -p "${WORK_TMP}/empty-soulchain"
set +e
RIGHT_BACKUP_OUT="$(
  timeout 5 docker run --rm \
    -e BACKUP_RCLONE_REMOTE="ghost-remote:npc/soulchain" \
    -e RCLONE_CONFIG="/config/rclone/rclone.conf" \
    -v "${RCLONE_RIGHT}:/config/rclone:ro" \
    -v "${WORK_TMP}/empty-soulchain:/data/soulchain:ro" \
    "$BACKUP_IMAGE" 2>&1
)"
RIGHT_BACKUP_RC=$?
set -e
# timeout exits 124 when the watch loop is still running — that means the guard passed.
# Exit 1 with "permissions" would mean the guard failed incorrectly.
if printf '%s\n' "$RIGHT_BACKUP_OUT" | grep -q "permissions"; then
  die "backup incorrectly failed permissions guard on correctly-owned rclone.conf:\n${RIGHT_BACKUP_OUT}"
fi
if [[ "$RIGHT_BACKUP_RC" -eq 1 ]]; then
  die "backup exited 1 on correctly-owned rclone.conf:\n${RIGHT_BACKUP_OUT}"
fi
log "OK correctly-owned rclone.conf passes backup entrypoint (exit ${RIGHT_BACKUP_RC})"

log "All uid/gid mount checks passed"
