#!/usr/bin/env bash
# Key-backup drill (#72): decrypt + byte-compare age-encrypted soul/door keys.
#
# Modes:
#   Offline (default, CI): fabricate fixture keys, throwaway age identity, local
#     rclone remote, then encrypt → decrypt → cmp + same-remote refusal.
#   Live (prod verify): set NPC_KEY_DRILL_LIVE=1 (or ensure AGE_IDENTITY_PATH is
#     set and readable). Downloads KEY_BACKUP_RCLONE_REMOTE/latest/*.age,
#     decrypts with AGE_IDENTITY_PATH, cmps against live SOUL_KEY_HOST_PATH /
#     DOOR_KEY_HOST_PATH. Never prints key material.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KEY_BACKUP="${SCRIPT_DIR}/key-backup.sh"
ENV_FILE="${NPC_ENV_FILE:-${REPO_ROOT}/ops/.env}"

log() {
  echo "[key-backup-drill] $*"
}

die() {
  echo "[key-backup-drill] ERROR: $*" >&2
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
  from_env="$(printenv "$key" 2>/dev/null || true)"
  if [[ -n "$from_env" ]]; then
    printf '%s' "$from_env"
    return 0
  fi
  if [[ -f "$ENV_FILE" ]]; then
    env_lookup "$ENV_FILE" "$key" || true
  fi
}

command -v age >/dev/null 2>&1 || die "age not found on PATH"
command -v rclone >/dev/null 2>&1 || die "rclone not found on PATH"

DRILL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/npc-key-backup-drill.XXXXXX")"
cleanup() {
  rm -rf "$DRILL_TMP"
}
trap cleanup EXIT

# Live mode: NPC_KEY_DRILL_LIVE=1, or AGE_IDENTITY_PATH set/readable (unless
# NPC_KEY_DRILL_LIVE=0 forces offline fixture mode).
age_identity="$(env_get AGE_IDENTITY_PATH)"
live_mode=0
if [[ "${NPC_KEY_DRILL_LIVE:-}" == "0" ]]; then
  live_mode=0
elif [[ "${NPC_KEY_DRILL_LIVE:-}" == "1" ]]; then
  live_mode=1
elif [[ -n "$age_identity" && -r "$age_identity" ]]; then
  live_mode=1
fi

if [[ "$live_mode" -eq 1 ]]; then
  log "live mode: decrypt remote latest and cmp against host keys"

  soul_key="$(env_get SOUL_KEY_HOST_PATH)"
  door_key="$(env_get DOOR_KEY_HOST_PATH)"
  key_remote="$(env_get KEY_BACKUP_RCLONE_REMOTE)"
  chain_remote="$(env_get BACKUP_RCLONE_REMOTE)"
  age_identity="$(env_get AGE_IDENTITY_PATH)"
  key_rclone_conf="$(env_get KEY_BACKUP_RCLONE_CONFIG)"
  rclone_conf_dir="$(env_get RCLONE_CONFIG_HOST_PATH)"

  [[ -n "$age_identity" && -r "$age_identity" ]] || \
    die "live mode requires readable AGE_IDENTITY_PATH"
  [[ -n "$soul_key" && -r "$soul_key" ]] || die "SOUL_KEY_HOST_PATH missing/unreadable"
  [[ -n "$door_key" && -r "$door_key" ]] || die "DOOR_KEY_HOST_PATH missing/unreadable"
  [[ -n "$key_remote" ]] || die "KEY_BACKUP_RCLONE_REMOTE is required"
  [[ -n "$chain_remote" ]] || die "BACKUP_RCLONE_REMOTE is required for safety compare"
  if [[ "$key_remote" == "$chain_remote" ]]; then
    die "KEY_BACKUP_RCLONE_REMOTE must differ from BACKUP_RCLONE_REMOTE"
  fi

  if [[ -n "$key_rclone_conf" ]]; then
    [[ -r "$key_rclone_conf" ]] || die "KEY_BACKUP_RCLONE_CONFIG not readable"
    export RCLONE_CONFIG="$key_rclone_conf"
  elif [[ -n "$rclone_conf_dir" ]]; then
    [[ -r "${rclone_conf_dir}/rclone.conf" ]] || die "rclone.conf not readable under RCLONE_CONFIG_HOST_PATH"
    export RCLONE_CONFIG="${rclone_conf_dir}/rclone.conf"
  else
    die "set KEY_BACKUP_RCLONE_CONFIG or RCLONE_CONFIG_HOST_PATH"
  fi

  latest="${key_remote%/}/latest"
  rclone copyto "${latest}/soul.key.age" "${DRILL_TMP}/soul.key.age" --quiet
  rclone copyto "${latest}/door.key.age" "${DRILL_TMP}/door.key.age" --quiet

  age -d -i "$age_identity" -o "${DRILL_TMP}/soul.out" "${DRILL_TMP}/soul.key.age"
  age -d -i "$age_identity" -o "${DRILL_TMP}/door.out" "${DRILL_TMP}/door.key.age"

  cmp -s "$soul_key" "${DRILL_TMP}/soul.out" || die "soul.key decrypt mismatch vs live key"
  cmp -s "$door_key" "${DRILL_TMP}/door.out" || die "door.key decrypt mismatch vs live key"

  log "OK (live)"
  exit 0
fi

# --- Offline fixture mode (CI default) ---
command -v age-keygen >/dev/null 2>&1 || die "age-keygen not found on PATH"

KEYS_DIR="${DRILL_TMP}/keys"
REMOTE_DIR="${DRILL_TMP}/remote"
mkdir -p "$KEYS_DIR" "$REMOTE_DIR"

# Deterministic fake 32-byte keys (fill bytes) — not production material.
python3 - <<'PY' "$KEYS_DIR"
import pathlib, sys
d = pathlib.Path(sys.argv[1])
(d / "soul.key").write_bytes(bytes([7]) * 32)
(d / "door.key").write_bytes(bytes([9]) * 32)
PY

age-keygen -o "${DRILL_TMP}/age-identity.txt" >/dev/null 2>&1
recipient="$(grep -E '^# public key:' "${DRILL_TMP}/age-identity.txt" | sed 's/^# public key: //')"
[[ -n "$recipient" ]] || die "failed to parse age recipient from age-keygen output"

RCLONE_CONF="${DRILL_TMP}/rclone.conf"
cat >"$RCLONE_CONF" <<EOF
[drillkeys]
type = local
nounc = true
EOF

export SOUL_KEY_HOST_PATH="${KEYS_DIR}/soul.key"
export DOOR_KEY_HOST_PATH="${KEYS_DIR}/door.key"
export AGE_RECIPIENT="$recipient"
export KEY_BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/keys"
export BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/chain-must-differ"
export KEY_BACKUP_RCLONE_CONFIG="$RCLONE_CONF"
export RCLONE_CONFIG="$RCLONE_CONF"
# Point env file away so key-backup does not load ops/.env placeholders.
export NPC_ENV_FILE="${DRILL_TMP}/empty.env"
: >"$NPC_ENV_FILE"
# Ensure live-mode auto-detect does not trip if the operator's shell exports AGE_IDENTITY_PATH.
unset AGE_IDENTITY_PATH || true
unset NPC_KEY_DRILL_LIVE || true

log "offline mode: running key-backup.sh against local rclone remote"
bash "$KEY_BACKUP"

latest="${REMOTE_DIR}/keys/latest"
[[ -f "${latest}/soul.key.age" ]] || die "missing ${latest}/soul.key.age"
[[ -f "${latest}/door.key.age" ]] || die "missing ${latest}/door.key.age"

log "decrypting and byte-comparing"
age -d -i "${DRILL_TMP}/age-identity.txt" -o "${DRILL_TMP}/soul.out" "${latest}/soul.key.age"
age -d -i "${DRILL_TMP}/age-identity.txt" -o "${DRILL_TMP}/door.out" "${latest}/door.key.age"

cmp -s "${KEYS_DIR}/soul.key" "${DRILL_TMP}/soul.out" || die "soul.key decrypt mismatch"
cmp -s "${KEYS_DIR}/door.key" "${DRILL_TMP}/door.out" || die "door.key decrypt mismatch"

# Exercise live mode against the local remote we just populated (CI coverage).
log "re-entering live mode against local remote"
NPC_KEY_DRILL_LIVE=1 \
  AGE_IDENTITY_PATH="${DRILL_TMP}/age-identity.txt" \
  SOUL_KEY_HOST_PATH="${KEYS_DIR}/soul.key" \
  DOOR_KEY_HOST_PATH="${KEYS_DIR}/door.key" \
  KEY_BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/keys" \
  BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/chain-must-differ" \
  KEY_BACKUP_RCLONE_CONFIG="$RCLONE_CONF" \
  RCLONE_CONFIG="$RCLONE_CONF" \
  NPC_ENV_FILE="${DRILL_TMP}/empty.env" \
  bash "$0" || die "live-mode re-entry failed"

# Safety: refuse identical remotes
export KEY_BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/same"
export BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/same"
if bash "$KEY_BACKUP" >/dev/null 2>&1; then
  die "key-backup.sh must refuse when KEY_BACKUP_RCLONE_REMOTE equals BACKUP_RCLONE_REMOTE"
fi

log "OK (offline + live re-entry)"
