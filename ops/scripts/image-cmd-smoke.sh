#!/usr/bin/env bash
# Ghost image CMD smoke check (#62).
# Asserts deployed images invoke node dist/*.js directly, not broken pnpm .bin shims (exit 127).
# Runs on Linux CI (GitHub ubuntu-latest) and macOS Docker Desktop — no bind-mount uid semantics required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUNTIME_IMAGE="npc-cmd-smoke-runtime:local"
DOOR_IMAGE="npc-cmd-smoke-door:local"
ATLAS_IMAGE="npc-cmd-smoke-atlas:local"

CONTAINER_PREFIX="npc-cmd-smoke-"

cleanup() {
  local ids
  ids="$(docker ps -aq --filter "name=${CONTAINER_PREFIX}" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log() {
  echo "[image-cmd-smoke] $*"
}

die() {
  echo "[image-cmd-smoke] ERROR: $*" >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  die "docker not found on PATH"
fi

assert_dist_exists() {
  local image="$1"
  local dist_path="$2"
  local label="$3"
  docker run --rm --entrypoint sh "$image" -c "test -f ${dist_path}"
  log "OK ${label}: ${dist_path} exists"
}

# Run the image default CMD for ~5s without --rm so we can inspect exit state.
# PASS: still running after 5s (CMD resolved; process booted), or exited with any code except 127.
# FAIL: exit 127 or output indicating "executable file not found" / ": not found" for old bin shims.
# CI uses GNU timeout elsewhere; here we use docker run -d + sleep for portability (macOS lacks timeout).
smoke_cmd() {
  local image="$1"
  local label="$2"
  local name="${CONTAINER_PREFIX}${label}-$$"

  docker run -d --name "$name" "$image" >/dev/null

  sleep 5

  local running
  running="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo "false")"

  if [[ "$running" == "true" ]]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    log "OK ${label}: still running after 5s (CMD resolved)"
    return 0
  fi

  local code
  code="$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo "unknown")"
  local output
  output="$(docker logs "$name" 2>&1 || true)"
  docker rm -f "$name" >/dev/null 2>&1 || true

  if [[ "$code" == "127" ]]; then
    die "${label}: CMD exited 127 (executable not found — likely broken pnpm .bin shim): ${output}"
  fi

  # Match Docker/shell bin-miss messages only — avoid false positives on app boot_failed text.
  if printf '%s\n' "$output" | grep -qE 'executable file not found|(atlas-api|door-discord|npc-runtime): not found'; then
    die "${label}: output suggests broken CMD (bin shim not found): ${output}"
  fi

  log "OK ${label}: CMD exited with code ${code} (not 127)"
}

log "Building runtime image (${RUNTIME_IMAGE})..."
docker build -f "${REPO_ROOT}/ops/Dockerfile.runtime" -t "$RUNTIME_IMAGE" "$REPO_ROOT"

log "Building door-discord image (${DOOR_IMAGE})..."
docker build -f "${REPO_ROOT}/ops/Dockerfile.door-discord" -t "$DOOR_IMAGE" "$REPO_ROOT"

log "Building atlas-api image (${ATLAS_IMAGE})..."
docker build -f "${REPO_ROOT}/ops/Dockerfile.atlas-api" -t "$ATLAS_IMAGE" "$REPO_ROOT"

assert_dist_exists "$RUNTIME_IMAGE" "dist/daemon.js" "runtime"
assert_dist_exists "$DOOR_IMAGE" "dist/server.js" "door-discord"
assert_dist_exists "$ATLAS_IMAGE" "dist/server.js" "atlas-api"

smoke_cmd "$RUNTIME_IMAGE" "runtime"
smoke_cmd "$DOOR_IMAGE" "door-discord"
smoke_cmd "$ATLAS_IMAGE" "atlas-api"

log "All image CMD smoke checks passed"
