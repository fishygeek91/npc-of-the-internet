#!/usr/bin/env bash
# Encrypt soul.key + door.key with age and copy to a SEPARATE rclone remote (#72).
# Never run inside the backup sidecar. Never use BACKUP_RCLONE_REMOTE.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${NPC_ENV_FILE:-${REPO_ROOT}/ops/.env}"

log() {
  echo "[key-backup] $*"
}

die() {
  echo "[key-backup] ERROR: $*" >&2
  exit 1
}

env_lookup() {
  local file="$1"
  local key="$2"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      \#*|"") continue ;;
    esac
    if [[ "$line" == "${key}="* ]]; then
      printf '%s' "${line#${key}=}"
      return 0
    fi
  done <"$file"
  return 1
}

env_get() {
  local key="$1"
  local from_env=""
  # Prefer already-exported process env (drills), else ops/.env.
  from_env="$(printenv "$key" 2>/dev/null || true)"
  if [[ -n "$from_env" ]]; then
    printf '%s' "$from_env"
    return 0
  fi
  if [[ -f "$ENV_FILE" ]]; then
    env_lookup "$ENV_FILE" "$key" || true
  fi
}

command -v age >/dev/null 2>&1 || die "age not found on PATH (install: brew install age)"
command -v rclone >/dev/null 2>&1 || die "rclone not found on PATH"

soul_key="$(env_get SOUL_KEY_HOST_PATH)"
door_key="$(env_get DOOR_KEY_HOST_PATH)"
recipient="$(env_get AGE_RECIPIENT)"
key_remote="$(env_get KEY_BACKUP_RCLONE_REMOTE)"
chain_remote="$(env_get BACKUP_RCLONE_REMOTE)"
rclone_conf_dir="$(env_get RCLONE_CONFIG_HOST_PATH)"
# Optional separate rclone config for key backup (different B2 app key).
key_rclone_conf="$(env_get KEY_BACKUP_RCLONE_CONFIG)"

[[ -n "$soul_key" && -r "$soul_key" ]] || die "SOUL_KEY_HOST_PATH missing/unreadable"
[[ -n "$door_key" && -r "$door_key" ]] || die "DOOR_KEY_HOST_PATH missing/unreadable"
[[ -n "$recipient" ]] || die "AGE_RECIPIENT is required (age recipient pubkey)"
[[ -n "$key_remote" ]] || die "KEY_BACKUP_RCLONE_REMOTE is required"
[[ -n "$chain_remote" ]] || die "BACKUP_RCLONE_REMOTE is required for safety compare"

if [[ "$key_remote" == "$chain_remote" ]]; then
  die "KEY_BACKUP_RCLONE_REMOTE must differ from BACKUP_RCLONE_REMOTE (separate bucket/prefix)"
fi

if [[ -n "$key_rclone_conf" ]]; then
  [[ -r "$key_rclone_conf" ]] || die "KEY_BACKUP_RCLONE_CONFIG not readable: ${key_rclone_conf}"
  export RCLONE_CONFIG="$key_rclone_conf"
elif [[ -n "$rclone_conf_dir" ]]; then
  [[ -r "${rclone_conf_dir}/rclone.conf" ]] || die "rclone.conf not readable under RCLONE_CONFIG_HOST_PATH"
  export RCLONE_CONFIG="${rclone_conf_dir}/rclone.conf"
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/npc-key-backup.XXXXXX")"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

log "encrypting keys with age"
age -r "$recipient" -o "${WORKDIR}/soul.key.age" <"$soul_key"
age -r "$recipient" -o "${WORKDIR}/door.key.age" <"$door_key"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${key_remote%/}/${stamp}"
log "uploading to ${dest}"
rclone copy "${WORKDIR}/soul.key.age" "${dest}/" --quiet
rclone copy "${WORKDIR}/door.key.age" "${dest}/" --quiet

# Also refresh a "latest/" prefix for drills.
latest="${key_remote%/}/latest"
rclone copyto "${WORKDIR}/soul.key.age" "${latest}/soul.key.age" --quiet
rclone copyto "${WORKDIR}/door.key.age" "${latest}/door.key.age" --quiet

log "OK uploaded encrypted keys to ${dest} and ${latest}"
