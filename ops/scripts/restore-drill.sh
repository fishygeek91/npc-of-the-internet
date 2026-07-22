#!/usr/bin/env bash
# Offline end-to-end restore drill: seed fixture → rclone remote → restore → osp verify.
# No network required. Safe to run on any dev machine with rclone + pnpm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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

if ! command -v rclone >/dev/null 2>&1; then
  die "rclone not found on PATH (install: brew install rclone)"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  die "pnpm not found on PATH"
fi

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

log "Scratch workspace: $DRILL_TMP"

# 1. Seed from fixture (chain.jsonl + blobs only; fixture-meta.json not needed for verify)
mkdir -p "$SEED_DIR"
cp "${FIXTURE_DIR}/chain.jsonl" "$SEED_DIR/"
cp -R "${FIXTURE_DIR}/blobs" "$SEED_DIR/"
log "Seeded from multi-residency fixture ($(wc -l < "$SEED_DIR/chain.jsonl" | tr -d ' ') records)"

# 2. Configure local rclone remote (no network)
mkdir -p "$REMOTE_DIR"
cat > "$RCLONE_CONF" <<EOF
[drilllocal]
type = local
nounc = true
EOF

# 3. Sync seed → remote (simulates backup upload)
log "rclone sync: seed → remote"
rclone sync "$SEED_DIR" "drilllocal:${REMOTE_DIR}" --config "$RCLONE_CONF" -v

# 4. Destroy local seed copy (simulates total local loss)
log "Destroying local seed copy"
rm -rf "$SEED_DIR"

# 5. Sync remote → restored dir (simulates restore)
mkdir -p "$RESTORED_DIR"
log "rclone sync: remote → restored"
rclone sync "drilllocal:${REMOTE_DIR}" "$RESTORED_DIR" --config "$RCLONE_CONF" -v

# 6. Verify restored chain — public keys from fixture-meta.json (TEST-ONLY; not secrets)
FIXTURE_META="${FIXTURE_DIR}/fixture-meta.json"
[[ -f "$FIXTURE_META" ]] || die "fixture-meta.json missing at $FIXTURE_META"

VERIFY_ARGS=()
while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  VERIFY_ARGS+=(--door-key "$key")
done < <(
  node --input-type=module -e "
import { readFileSync } from \"node:fs\";
const meta = JSON.parse(readFileSync(process.argv[1], \"utf8\"));
for (const key of meta.doorPublicKeys ?? []) {
  if (typeof key === \"string\" && key.length > 0) process.stdout.write(key + \"\\n\");
}
" "$FIXTURE_META"
)

[[ ${#VERIFY_ARGS[@]} -gt 0 ]] || die "no doorPublicKeys found in $FIXTURE_META"

log "Running osp verify on restored chain"
(
  cd "$REPO_ROOT"
  node "$OSP_BIN" verify "$RESTORED_DIR" "${VERIFY_ARGS[@]}"
)

log "SUCCESS: restore drill passed — fixture chain restored and verified offline"
