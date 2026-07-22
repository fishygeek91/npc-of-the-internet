#!/usr/bin/env bash
# Offline end-to-end launch dry-run: osp init → first residency → atlas → backup/restore → verify.
# No network required. Safe to run on any dev machine with rclone + pnpm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DRILL_TMP=""
RCLONE_CONF=""
ATLAS_PID=""

cleanup() {
  if [[ -n "${ATLAS_PID}" ]] && kill -0 "${ATLAS_PID}" 2>/dev/null; then
    kill "${ATLAS_PID}" 2>/dev/null || true
    wait "${ATLAS_PID}" 2>/dev/null || true
  fi
  if [[ -n "$DRILL_TMP" && -d "$DRILL_TMP" ]]; then
    rm -rf "$DRILL_TMP"
  fi
  if [[ -n "$RCLONE_CONF" && -f "$RCLONE_CONF" ]]; then
    rm -f "$RCLONE_CONF"
  fi
}
trap cleanup EXIT

log() {
  echo "[launch-dry-run] $*"
}

die() {
  echo "[launch-dry-run] ERROR: $*" >&2
  exit 1
}

if ! command -v rclone >/dev/null 2>&1; then
  die "rclone not found on PATH (install: brew install rclone)"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  die "pnpm not found on PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  die "node not found on PATH"
fi

OSP_BIN="${REPO_ROOT}/packages/osp-cli/dist/cli.js"
ATLAS_BIN="${REPO_ROOT}/packages/atlas/dist/server.js"
RESIDENCY_BIN="${REPO_ROOT}/ops/scripts/launch-first-residency.mjs"

log "Building workspace packages for dry-run..."
(
  cd "$REPO_ROOT"
  pnpm --filter @npc/osp-cli... --filter @npc/runtime... --filter @npc/door-sdk... --filter @npc/atlas... build
)

[[ -f "$OSP_BIN" ]] || die "osp CLI build failed: $OSP_BIN"
[[ -f "$ATLAS_BIN" ]] || die "atlas API build failed: $ATLAS_BIN"
[[ -f "$RESIDENCY_BIN" ]] || die "residency harness missing: $RESIDENCY_BIN"

DRILL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/launch-dry-run.XXXXXX")"
CHAIN_DIR="${DRILL_TMP}/chain"
REMOTE_DIR="${DRILL_TMP}/remote"
RESTORED_DIR="${DRILL_TMP}/restored"
RCLONE_CONF="${DRILL_TMP}/rclone.conf"

log "Scratch workspace: $DRILL_TMP"

# 1. Initialize soulchain with real charter
mkdir -p "$CHAIN_DIR"
INIT_OUT="$(
  cd "$REPO_ROOT"
  node "$OSP_BIN" init "$CHAIN_DIR" --charter "${REPO_ROOT}/spec/osp/genesis.md"
)"
GENESIS_CID="$(printf '%s\n' "$INIT_OUT" | sed -n 's/^Genesis CID: //p')"
SOUL_PUBKEY="$(printf '%s\n' "$INIT_OUT" | sed -n 's/^Soul public key: //p')"
[[ -n "$GENESIS_CID" ]] || die "failed to parse Genesis CID from osp init output"
[[ -n "$SOUL_PUBKEY" ]] || die "failed to parse Soul public key from osp init output"
log "Initialized chain (genesis ${GENESIS_CID:0:13}…)"

# 2. First residency (Session + Door + FakeBrain, offline)
RESIDENCY_OUT="$(
  cd "$REPO_ROOT"
  CHAIN_DIR="$CHAIN_DIR" node "$RESIDENCY_BIN"
)"
DOOR_PUBLIC_KEY="$(printf '%s\n' "$RESIDENCY_OUT" | sed -n 's/^DOOR_PUBLIC_KEY=//p')"
RESIDENCY_OK="$(printf '%s\n' "$RESIDENCY_OUT" | sed -n 's/^RESIDENCY_OK=//p')"
[[ "$RESIDENCY_OK" == "1" ]] || die "launch-first-residency.mjs did not report RESIDENCY_OK=1"
[[ -n "$DOOR_PUBLIC_KEY" ]] || die "failed to parse DOOR_PUBLIC_KEY from residency harness"
log "First residency complete (door key ${DOOR_PUBLIC_KEY:0:13}…)"

# 3. Verify live chain before backup
log "osp verify on live chain"
(
  cd "$REPO_ROOT"
  node "$OSP_BIN" verify "$CHAIN_DIR" --door-key "$DOOR_PUBLIC_KEY"
)

# 4. Atlas API smoke against live chain
ATLAS_PORT="$(
  node --input-type=module -e "
import net from \"node:net\";
const server = net.createServer();
server.listen(0, \"127.0.0.1\", () => {
  const address = server.address();
  if (address === null || typeof address === \"string\") {
    process.stderr.write(\"failed to bind ephemeral port\\n\");
    process.exit(1);
  }
  process.stdout.write(String(address.port));
  server.close();
});
"
)"
log "Starting atlas-api on 127.0.0.1:${ATLAS_PORT}"
ATLAS_CHAIN_DIR="$CHAIN_DIR" ATLAS_PORT="$ATLAS_PORT" ATLAS_DOOR_PUBKEYS="$DOOR_PUBLIC_KEY" \
  node "$ATLAS_BIN" &
ATLAS_PID=$!

ATLAS_READY=0
for _ in $(seq 1 50); do
  if ATLAS_PORT="$ATLAS_PORT" node --input-type=module -e "
const port = process.env.ATLAS_PORT;
const response = await fetch(\`http://127.0.0.1:\${port}/state\`);
if (!response.ok) process.exit(1);
const body = await response.json();
if (body.status !== \"present\") process.exit(2);
process.exit(0);
" 2>/dev/null; then
    ATLAS_READY=1
    break
  fi
  sleep 0.1
done
[[ "$ATLAS_READY" -eq 1 ]] || die "atlas /state did not report status=present within timeout"

HEAD_CID="$(
  ATLAS_PORT="$ATLAS_PORT" node --input-type=module -e "
const port = process.env.ATLAS_PORT;
const response = await fetch(\`http://127.0.0.1:\${port}/chain/head\`);
if (!response.ok) {
  process.stderr.write(\`atlas /chain/head failed: \${response.status}\\n\`);
  process.exit(1);
}
const body = await response.json();
if (typeof body.cid !== \"string\" || body.cid.length === 0) {
  process.stderr.write(\"atlas /chain/head missing cid\\n\");
  process.exit(1);
}
process.stdout.write(body.cid);
"
)"
log "Atlas reports present (head ${HEAD_CID:0:13}…)"

kill "${ATLAS_PID}" 2>/dev/null || true
wait "${ATLAS_PID}" 2>/dev/null || true
ATLAS_PID=""

# 5. Backup + restore via local rclone (mirror restore-drill)
mkdir -p "$REMOTE_DIR"
cat > "$RCLONE_CONF" <<EOF
[drilllocal]
type = local
nounc = true
EOF

# Match production backup shape: chain.jsonl + blobs/ only — never private keys
# (see ops/RUNBOOK.md backup sidecar and LAUNCH.md custody rules).
log "rclone sync: chain → remote (chain.jsonl + blobs only)"
rclone sync "$CHAIN_DIR" "drilllocal:${REMOTE_DIR}" --config "$RCLONE_CONF" \
  --exclude "soul.key" \
  --exclude "door.key" \
  --exclude "door.pubkey" \
  --exclude "dry-run-meta.json" \
  -v

log "Destroying local chain copy"
rm -rf "$CHAIN_DIR"

mkdir -p "$RESTORED_DIR"
log "rclone sync: remote → restored"
rclone sync "drilllocal:${REMOTE_DIR}" "$RESTORED_DIR" --config "$RCLONE_CONF" -v

[[ -f "${RESTORED_DIR}/chain.jsonl" ]] || die "restored chain.jsonl missing"
[[ -d "${RESTORED_DIR}/blobs" ]] || die "restored blobs/ missing"
[[ ! -e "${RESTORED_DIR}/soul.key" ]] || die "restored tree must not contain soul.key"
[[ ! -e "${RESTORED_DIR}/door.key" ]] || die "restored tree must not contain door.key"

log "osp verify on restored chain"
(
  cd "$REPO_ROOT"
  node "$OSP_BIN" verify "$RESTORED_DIR" --door-key "$DOOR_PUBLIC_KEY"
)

printf 'Genesis CID: %s\n' "$GENESIS_CID"
printf 'Head CID: %s\n' "$HEAD_CID"
printf 'Soul public key: %s\n' "$SOUL_PUBKEY"
log "SUCCESS: launch dry-run passed — init, residency, atlas, backup/restore, and verify offline"
