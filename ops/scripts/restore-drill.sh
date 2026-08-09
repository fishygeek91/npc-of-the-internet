#!/usr/bin/env bash
# Offline end-to-end restore drill + anti-clobber proofs (Bug #63).
# Seed fixture → backup-watch (BACKUP_ONCE) → restore → osp verify;
# then prove truncated chain / deleted blobs cannot destroy the remote.
# No network required. Safe to run on any dev machine with rclone + pnpm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_WATCH="${SCRIPT_DIR}/backup-watch.sh"

DRILL_TMP=""
RCLONE_CONF=""

cleanup() {
  if [[ -n "$DRILL_TMP" && -d "$DRILL_TMP" ]]; then
    rm -rf "$DRILL_TMP"
  fi
  if [[ -n "$RCLONE_CONF" && -f "$RCLONE_CONF" ]]; then
    rm -f "$RCLONE_CONF"
  fi
}
trap cleanup EXIT

log() {
  echo "[restore-drill] $*"
}

die() {
  echo "[restore-drill] ERROR: $*" >&2
  exit 1
}

run_backup_once() {
  local source_dir="$1"
  local rc=0
  BACKUP_SOURCE_DIR="$source_dir" \
    BACKUP_RCLONE_REMOTE="drilllocal:${REMOTE_DIR}" \
    RCLONE_CONFIG="$RCLONE_CONF" \
    BACKUP_ONCE=1 \
    BACKUP_OK_PATH="${DRILL_TMP}/backup.ok" \
    ALLOW_CHAIN_SHRINK="${ALLOW_CHAIN_SHRINK:-}" \
    bash "$BACKUP_WATCH" || rc=$?
  return "$rc"
}

if ! command -v rclone >/dev/null 2>&1; then
  die "rclone not found on PATH (install: brew install rclone)"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  die "pnpm not found on PATH"
fi

[[ -x "$BACKUP_WATCH" || -f "$BACKUP_WATCH" ]] || die "backup-watch.sh missing at $BACKUP_WATCH"

FIXTURE_DIR="${REPO_ROOT}/packages/atlas/test/fixtures/multi-residency"
[[ -f "${FIXTURE_DIR}/chain.jsonl" ]] || die "fixture chain.jsonl missing at $FIXTURE_DIR"
[[ -d "${FIXTURE_DIR}/blobs" ]] || die "fixture blobs/ missing at $FIXTURE_DIR"

# Ensure osp CLI is built
OSP_BIN="${REPO_ROOT}/packages/osp-cli/dist/cli.js"
if [[ ! -f "$OSP_BIN" ]]; then
  log "Building @npc/osp-cli..."
  (cd "$REPO_ROOT" && pnpm --filter @npc/osp-cli build)
fi
[[ -f "$OSP_BIN" ]] || die "osp CLI build failed: $OSP_BIN"

DRILL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/restore-drill.XXXXXX")"
SEED_DIR="${DRILL_TMP}/seed"
REMOTE_DIR="${DRILL_TMP}/remote"
RESTORED_DIR="${DRILL_TMP}/restored"
RCLONE_CONF="${DRILL_TMP}/rclone.conf"
CHAIN_GOLDEN="${DRILL_TMP}/chain.golden.jsonl"

log "Scratch workspace: $DRILL_TMP"

# --- Phase A: happy-path seed → hardened backup → restore → verify ---

mkdir -p "$SEED_DIR"
cp "${FIXTURE_DIR}/chain.jsonl" "$SEED_DIR/"
cp -R "${FIXTURE_DIR}/blobs" "$SEED_DIR/"
cp "${SEED_DIR}/chain.jsonl" "$CHAIN_GOLDEN"
log "Seeded from multi-residency fixture ($(wc -l < "$SEED_DIR/chain.jsonl" | tr -d ' ') records)"

mkdir -p "$REMOTE_DIR"
cat > "$RCLONE_CONF" <<EOF
[drilllocal]
type = local
nounc = true
EOF

log "backup-watch BACKUP_ONCE: seed → remote (append-only semantics)"
ALLOW_CHAIN_SHRINK="" run_backup_once "$SEED_DIR" || die "initial BACKUP_ONCE failed"
[[ -f "${DRILL_TMP}/backup.ok" ]] || die "expected ${DRILL_TMP}/backup.ok after successful sync"
[[ -f "${REMOTE_DIR}/chain.jsonl" ]] || die "remote chain.jsonl missing after backup"
[[ -d "${REMOTE_DIR}/blobs" ]] || die "remote blobs/ missing after backup"
cmp -s "$CHAIN_GOLDEN" "${REMOTE_DIR}/chain.jsonl" || die "remote chain differs from seed after initial backup"

log "Destroying local seed copy"
rm -rf "$SEED_DIR"

mkdir -p "$RESTORED_DIR"
log "rclone sync: remote → restored"
rclone sync "drilllocal:${REMOTE_DIR}" "$RESTORED_DIR" --config "$RCLONE_CONF" -v

FIXTURE_META="${FIXTURE_DIR}/fixture-meta.json"
[[ -f "$FIXTURE_META" ]] || die "fixture-meta.json missing at $FIXTURE_META"

VERIFY_ARGS=()
while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  # Equals form required: base64url keys may start with '-' and confuse parseArgs.
  VERIFY_ARGS+=(--door-key="$key")
done < <(
  node --input-type=module -e "
import { readFileSync } from \"node:fs\";
const meta = JSON.parse(readFileSync(process.argv[1], \"utf8\"));
const keys = meta.doorPublicKeys;
if (keys !== undefined && keys !== null && typeof keys === \"object\" && !Array.isArray(keys)) {
  for (const [doorId, keyB64] of Object.entries(keys)) {
    if (typeof doorId === \"string\" && doorId.length > 0 && typeof keyB64 === \"string\" && keyB64.length > 0) {
      process.stdout.write(doorId + \"=\" + keyB64 + \"\\n\");
    }
  }
}
" "$FIXTURE_META"
)

[[ ${#VERIFY_ARGS[@]} -gt 0 ]] || die "no doorPublicKeys found in $FIXTURE_META"

log "Running osp verify on restored chain"
(
  cd "$REPO_ROOT"
  node "$OSP_BIN" verify "$RESTORED_DIR" "${VERIFY_ARGS[@]}"
)
log "Phase A OK: restore + verify"

# --- Phase B: anti-clobber ---

# Recreate a working local tree from the verified remote tip.
WORK_DIR="${DRILL_TMP}/work"
mkdir -p "$WORK_DIR"
rclone sync "drilllocal:${REMOTE_DIR}" "$WORK_DIR" --config "$RCLONE_CONF" -v
# Drop history/ from the working tree so local layout matches a soulchain dir.
rm -rf "${WORK_DIR}/history"

log "Phase B1: truncated local chain must not clobber remote"
cp "${REMOTE_DIR}/chain.jsonl" "${DRILL_TMP}/remote-chain-before-shrink.jsonl"
# Keep only the first line → strictly smaller than a multi-record fixture chain.
head -n 1 "${WORK_DIR}/chain.jsonl" > "${WORK_DIR}/chain.jsonl.truncated"
mv "${WORK_DIR}/chain.jsonl.truncated" "${WORK_DIR}/chain.jsonl"
rm -f "${DRILL_TMP}/backup.ok"
shrink_rc=0
ALLOW_CHAIN_SHRINK="" run_backup_once "$WORK_DIR" || shrink_rc=$?
[[ "$shrink_rc" -ne 0 ]] || die "expected BACKUP_ONCE to refuse smaller chain.jsonl (exit non-zero)"
cmp -s "${DRILL_TMP}/remote-chain-before-shrink.jsonl" "${REMOTE_DIR}/chain.jsonl" \
  || die "remote chain.jsonl was overwritten by a truncated local chain"
[[ ! -f "${DRILL_TMP}/backup.ok" ]] || die "backup.ok must not be touched when shrink guard refuses"
log "Phase B1 OK: shrink guard refused; remote tip intact"

log "Phase B2: local blob deletion must not delete remote blobs"
# Restore a full local chain for subsequent uploads (same size as remote → allowed).
cp "${REMOTE_DIR}/chain.jsonl" "${WORK_DIR}/chain.jsonl"
BLOB_SAMPLE="$(find "${WORK_DIR}/blobs" -type f | head -n 1 || true)"
[[ -n "$BLOB_SAMPLE" ]] || die "no blob files under work/blobs"
BLOB_REL="${BLOB_SAMPLE#"${WORK_DIR}/"}"
BLOB_REMOTE="${REMOTE_DIR}/${BLOB_REL}"
[[ -f "$BLOB_REMOTE" ]] || die "remote missing sample blob before delete test: $BLOB_REL"
rm -f "$BLOB_SAMPLE"
ALLOW_CHAIN_SHRINK="" run_backup_once "$WORK_DIR" || die "BACKUP_ONCE failed after local blob delete (should still succeed)"
[[ -f "$BLOB_REMOTE" ]] || die "remote blob was deleted after local deletion (rclone sync regression): $BLOB_REL"
log "Phase B2 OK: remote retained blob ${BLOB_REL}"

log "Phase B3: successful overwrite must leave history/<UTC>-<pid>/chain.jsonl"
# Grow the chain so copyto replaces the tip (identical files may be skipped).
printf "\n" >> "${WORK_DIR}/chain.jsonl"
# Recreate the deleted blob locally so the tree is otherwise healthy (copy is fine either way).
mkdir -p "$(dirname "$BLOB_SAMPLE")"
cp "$BLOB_REMOTE" "$BLOB_SAMPLE"
history_before=0
if [[ -d "${REMOTE_DIR}/history" ]]; then
  history_before="$(find "${REMOTE_DIR}/history" -type f -name "chain.jsonl" | wc -l | tr -d ' ')"
fi
ALLOW_CHAIN_SHRINK="" run_backup_once "$WORK_DIR" || die "BACKUP_ONCE failed when uploading grown chain"
history_after=0
if [[ -d "${REMOTE_DIR}/history" ]]; then
  history_after="$(find "${REMOTE_DIR}/history" -type f -name "chain.jsonl" | wc -l | tr -d ' ')"
fi
(( history_after > history_before )) || die "expected new history/*/chain.jsonl after overwrite (before=${history_before} after=${history_after})"
[[ -f "${DRILL_TMP}/backup.ok" ]] || die "expected backup.ok after successful grown-chain upload"
log "Phase B3 OK: history tip archived under remote/history/"

log "SUCCESS: restore drill + anti-clobber passed — fixture restored/verified; shrink/blob/history guards hold"
