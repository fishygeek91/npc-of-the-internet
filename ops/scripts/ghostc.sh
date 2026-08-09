#!/usr/bin/env bash
# Ghost compose wrapper (#72): run preflight, then docker compose with Ghost files.
# Usage (from anywhere): bash ops/scripts/ghostc.sh up -d
# Alias suggestion: alias ghostc='bash ~/npc/ops/scripts/ghostc.sh'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${NPC_ENV_FILE:-${REPO_ROOT}/ops/.env}"
COMPOSE_FILE="${REPO_ROOT}/ops/compose.ghost.yml"
SECRETS_FILE="${REPO_ROOT}/ops/compose.secrets.yml"

# Skip preflight for inspect/stop commands (preflight gates starting, not stopping).
skip_preflight=0
case "${1:-}" in
  config|ps|logs|version|down|stop|kill) skip_preflight=1 ;;
esac
if [[ "${NPC_SKIP_PREFLIGHT:-}" == "1" ]]; then
  skip_preflight=1
fi

if [[ "$skip_preflight" -eq 0 ]]; then
  NPC_ENV_FILE="$ENV_FILE" bash "${SCRIPT_DIR}/preflight.sh"
fi

compose_args=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
if [[ "${NPC_COMPOSE_SECRETS:-}" == "1" ]]; then
  compose_args+=(-f "$SECRETS_FILE")
fi

exec docker compose "${compose_args[@]}" "$@"
