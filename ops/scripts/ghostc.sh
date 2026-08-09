#!/usr/bin/env bash
# Ghost compose wrapper (#72): run preflight, then docker compose with Ghost files.
# Usage (from anywhere): bash ops/scripts/ghostc.sh up -d
# Alias suggestion: alias ghostc='bash ~/npc/ops/scripts/ghostc.sh'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${NPC_ENV_FILE:-${REPO_ROOT}/ops/.env}"
COMPOSE_FILE="${REPO_ROOT}/ops/compose.ghost.yml"

# Skip preflight for read-only inspect commands that operators use while debugging
# a failed preflight (config/ps/logs). Everything else requires a green preflight.
skip_preflight=0
if [[ "${1:-}" == "config" || "${1:-}" == "ps" || "${1:-}" == "logs" || "${1:-}" == "version" ]]; then
  skip_preflight=1
fi
if [[ "${NPC_SKIP_PREFLIGHT:-}" == "1" ]]; then
  skip_preflight=1
fi

if [[ "$skip_preflight" -eq 0 ]]; then
  NPC_ENV_FILE="$ENV_FILE" bash "${SCRIPT_DIR}/preflight.sh"
fi

exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
