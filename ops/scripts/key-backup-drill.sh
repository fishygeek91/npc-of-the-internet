#!/usr/bin/env bash
# Offline key-backup drill (#72): age-encrypt → local rclone remote → decrypt → cmp.
# Also usable against a real KEY_BACKUP_RCLONE_REMOTE when AGE_IDENTITY_PATH is set.
# Never prints key material.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KEY_BACKUP="${SCRIPT_DIR}/key-backup.sh"

log() {
  echo "[key-backup-drill] $*"
}

die() {
  echo "[key-backup-drill] ERROR: $*" >&2
  exit 1
}

command -v age >/dev/null 2>&1 || die "age not found on PATH"
command -v age-keygen >/dev/null 2>&1 || die "age-keygen not found on PATH"
command -v rclone >/dev/null 2>&1 || die "rclone not found on PATH"

DRILL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/npc-key-backup-drill.XXXXXX")"
cleanup() {
  rm -rf "$DRILL_TMP"
}
trap cleanup EXIT

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

log "running key-backup.sh against local rclone remote"
bash "$KEY_BACKUP"

latest="${REMOTE_DIR}/keys/latest"
[[ -f "${latest}/soul.key.age" ]] || die "missing ${latest}/soul.key.age"
[[ -f "${latest}/door.key.age" ]] || die "missing ${latest}/door.key.age"

log "decrypting and byte-comparing"
age -d -i "${DRILL_TMP}/age-identity.txt" -o "${DRILL_TMP}/soul.out" "${latest}/soul.key.age"
age -d -i "${DRILL_TMP}/age-identity.txt" -o "${DRILL_TMP}/door.out" "${latest}/door.key.age"

cmp -s "${KEYS_DIR}/soul.key" "${DRILL_TMP}/soul.out" || die "soul.key decrypt mismatch"
cmp -s "${KEYS_DIR}/door.key" "${DRILL_TMP}/door.out" || die "door.key decrypt mismatch"

# Safety: refuse identical remotes
export KEY_BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/same"
export BACKUP_RCLONE_REMOTE="drillkeys:${REMOTE_DIR}/same"
if bash "$KEY_BACKUP" >/dev/null 2>&1; then
  die "key-backup.sh must refuse when KEY_BACKUP_RCLONE_REMOTE equals BACKUP_RCLONE_REMOTE"
fi

log "OK"
