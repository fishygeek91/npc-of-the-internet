#!/usr/bin/env bash
# Ghost ops preflight (#72): fail fast on placeholder .env, /tmp custody paths,
# pubkey mismatches, unreachable rclone remote, or invalid compose config.
# Requires bash ≥ 3.2 (no associative arrays).
# Env file format: KEY=value only — no quotes, no `export` prefix (dotenv-simple).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${NPC_ENV_FILE:-${REPO_ROOT}/ops/.env}"
ENV_EXAMPLE="${REPO_ROOT}/ops/.env.example"
COMPOSE_FILE="${REPO_ROOT}/ops/compose.ghost.yml"
KEYS_HELPER="${SCRIPT_DIR}/preflight-keys.mjs"

log() {
  echo "[preflight] $*"
}

die() {
  echo "[preflight] ERROR: $*" >&2
  exit 1
}

# Read KEY from a dotenv-style file (first match). Prints value without trailing newline issues.
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
  local value=""
  value="$(env_lookup "$ENV_FILE" "$key" || true)"
  printf '%s' "$value"
}

example_get() {
  local key="$1"
  local value=""
  value="$(env_lookup "$ENV_EXAMPLE" "$key" || true)"
  printf '%s' "$value"
}

[[ -f "$ENV_FILE" ]] || die "missing env file: ${ENV_FILE} (copy ops/.env.example → ops/.env)"
[[ -f "$ENV_EXAMPLE" ]] || die "missing ${ENV_EXAMPLE}"
[[ -f "$COMPOSE_FILE" ]] || die "missing ${COMPOSE_FILE}"

# Secret / identity / path keys that must not equal .env.example (plan decision 11).
COMPARE_KEYS=(
  ANTHROPIC_API_KEY
  NPC_BRAIN_API_KEY
  DISCORD_BOT_TOKEN
  DISCORD_GUILD_ID
  DISCORD_CHANNEL_ID
  DISCORD_OPERATOR_IDS
  SOUL_PUBLIC_KEY
  ATLAS_DOOR_PUBKEYS
  SOUL_KEY_HOST_PATH
  DOOR_KEY_HOST_PATH
  RCLONE_CONFIG_HOST_PATH
  BACKUP_RCLONE_REMOTE
)

for key in "${COMPARE_KEYS[@]}"; do
  actual="$(env_get "$key")"
  example="$(example_get "$key")"
  if [[ -n "$actual" && -n "$example" && "$actual" == "$example" ]]; then
    die "${key} still equals ops/.env.example default — replace before launch"
  fi
done

PATH_KEYS=(SOUL_KEY_HOST_PATH DOOR_KEY_HOST_PATH RCLONE_CONFIG_HOST_PATH)
for key in "${PATH_KEYS[@]}"; do
  value="$(env_get "$key")"
  [[ -n "$value" ]] || die "${key} is unset"
  if [[ "$value" == /tmp/* ]]; then
    die "${key}=${value} starts with /tmp (not persistent custody)"
  fi
done

for key in ANTHROPIC_API_KEY_HOST_PATH NPC_BRAIN_API_KEY_HOST_PATH DISCORD_BOT_TOKEN_HOST_PATH; do
  value="$(env_get "$key")"
  if [[ -n "$value" && "$value" == /tmp/* ]]; then
    die "${key}=${value} starts with /tmp"
  fi
done

# Exactly one of NAME or NAME_FILE for path-based secrets (matches package loaders).
assert_exactly_one_secret() {
  local name="$1"
  local file_name="$2"
  local direct file_path
  direct="$(env_get "$name")"
  file_path="$(env_get "$file_name")"
  if [[ -n "$direct" && -n "$file_path" ]]; then
    die "set only one of ${name} or ${file_name} (comment out the unused var)"
  fi
  if [[ -z "$direct" && -z "$file_path" ]]; then
    die "${name} or ${file_name} is required"
  fi
}
brain_provider="$(env_get NPC_BRAIN_PROVIDER)"
if [[ -z "$brain_provider" || "$brain_provider" == "anthropic" ]]; then
  assert_exactly_one_secret ANTHROPIC_API_KEY ANTHROPIC_API_KEY_FILE
elif [[ "$brain_provider" == "openai-compat" ]]; then
  assert_exactly_one_secret NPC_BRAIN_API_KEY NPC_BRAIN_API_KEY_FILE
  brain_base="$(env_get NPC_BRAIN_BASE_URL)"
  [[ -n "$brain_base" ]] || die "NPC_BRAIN_BASE_URL is required when NPC_BRAIN_PROVIDER=openai-compat"
  brain_model="$(env_get NPC_BRAIN_MODEL)"
  [[ -n "$brain_model" ]] || die "NPC_BRAIN_MODEL is required when NPC_BRAIN_PROVIDER=openai-compat"
  case "$brain_base" in
    *openrouter.ai*)
      allowlist="$(env_get NPC_BRAIN_PROVIDER_ALLOWLIST)"
      [[ -n "$allowlist" ]] || die "NPC_BRAIN_PROVIDER_ALLOWLIST is required and must be non-empty for OpenRouter"
      ;;
  esac
else
  die "NPC_BRAIN_PROVIDER must be anthropic or openai-compat (got ${brain_provider})"
fi
assert_exactly_one_secret DISCORD_BOT_TOKEN DISCORD_BOT_TOKEN_FILE

key_remote="$(env_get KEY_BACKUP_RCLONE_REMOTE)"
chain_remote="$(env_get BACKUP_RCLONE_REMOTE)"
if [[ -n "$key_remote" && -n "$chain_remote" && "$key_remote" == "$chain_remote" ]]; then
  die "KEY_BACKUP_RCLONE_REMOTE must differ from BACKUP_RCLONE_REMOTE"
fi

command -v node >/dev/null 2>&1 || die "node not found on PATH"
command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
command -v rclone >/dev/null 2>&1 || die "rclone not found on PATH"

[[ -f "${REPO_ROOT}/packages/osp-core/dist/index.js" ]] || \
  die "build @npc/osp-core first (pnpm --filter @npc/osp-core build)"

soul_key_path="$(env_get SOUL_KEY_HOST_PATH)"
door_key_path="$(env_get DOOR_KEY_HOST_PATH)"
[[ -r "$soul_key_path" ]] || die "SOUL_KEY_HOST_PATH not readable: ${soul_key_path}"
[[ -r "$door_key_path" ]] || die "DOOR_KEY_HOST_PATH not readable: ${door_key_path}"

derived_soul="$(node "$KEYS_HELPER" soul "$soul_key_path")" || die "failed to derive soul public key"
env_soul="$(env_get SOUL_PUBLIC_KEY)"
[[ -n "$env_soul" ]] || die "SOUL_PUBLIC_KEY is unset"
if [[ "$derived_soul" != "$env_soul" ]]; then
  die "SOUL_PUBLIC_KEY does not match public key derived from ${soul_key_path}"
fi

derived_door="$(node "$KEYS_HELPER" door "$door_key_path")" || die "failed to derive door public key"
guild_id="$(env_get DISCORD_GUILD_ID)"
[[ -n "$guild_id" ]] || die "DISCORD_GUILD_ID is unset"
door_id="discord:${guild_id}"
atlas_bindings="$(env_get ATLAS_DOOR_PUBKEYS)"
[[ -n "$atlas_bindings" ]] || die "ATLAS_DOOR_PUBKEYS is unset"

found_binding=""
old_ifs="$IFS"
IFS=','
# shellcheck disable=SC2086
set -- $atlas_bindings
IFS="$old_ifs"
for part in "$@"; do
  trimmed="$(printf '%s' "$part" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ "$trimmed" == "${door_id}="* ]]; then
    found_binding="${trimmed#${door_id}=}"
    break
  fi
done
[[ -n "$found_binding" ]] || die "ATLAS_DOOR_PUBKEYS missing binding for ${door_id}"
if [[ "$found_binding" != "$derived_door" ]]; then
  die "ATLAS_DOOR_PUBKEYS binding for ${door_id} does not match ${door_key_path}"
fi

rclone_remote="$(env_get BACKUP_RCLONE_REMOTE)"
[[ -n "$rclone_remote" ]] || die "BACKUP_RCLONE_REMOTE is unset"
rclone_conf_dir="$(env_get RCLONE_CONFIG_HOST_PATH)"
rclone_conf="${rclone_conf_dir}/rclone.conf"
[[ -r "$rclone_conf" ]] || die "rclone.conf not readable at ${rclone_conf}"

# Probe the configured path (not the account root) so bucket-scoped B2 app keys work.
log "checking rclone remote ${rclone_remote}"
RCLONE_CONFIG="$rclone_conf" rclone lsjson --max-depth 1 "$rclone_remote" >/dev/null 2>&1 || \
  die "rclone remote unreachable: ${rclone_remote} (fix rclone.conf / credentials)"

log "validating compose config"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null || \
  die "docker compose config failed for ${COMPOSE_FILE}"

log "OK"
