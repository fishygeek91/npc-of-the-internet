#!/usr/bin/env bash
# Ghost compose wrapper (#72): run preflight, then docker compose with Ghost files.
# Usage (from anywhere): bash ops/scripts/ghostc.sh up -d
# Alias suggestion: alias ghostc='bash ~/npc/ops/scripts/ghostc.sh'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${NPC_ENV_FILE:-${REPO_ROOT}/ops/.env}"
COMPOSE_FILE="${REPO_ROOT}/ops/compose.ghost.yml"
# NPC_COMPOSE_SECRETS=1 → compose.secrets.yml (openai-compat brain key, production);
# NPC_COMPOSE_SECRETS=anthropic → compose.secrets.anthropic.yml.
SECRETS_FILE="${REPO_ROOT}/ops/compose.secrets.yml"
SECRETS_FILE_ANTHROPIC="${REPO_ROOT}/ops/compose.secrets.anthropic.yml"

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
case "${NPC_COMPOSE_SECRETS:-}" in
  "" | 0) ;;
  1) compose_args+=(-f "$SECRETS_FILE") ;;
  anthropic) compose_args+=(-f "$SECRETS_FILE_ANTHROPIC") ;;
  *)
    echo "[ghostc] ERROR: NPC_COMPOSE_SECRETS must be 1 (openai-compat) or anthropic, got '${NPC_COMPOSE_SECRETS}'" >&2
    exit 1
    ;;
esac

exec docker compose "${compose_args[@]}" "$@"
