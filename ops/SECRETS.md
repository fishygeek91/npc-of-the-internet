# Secrets — NPC of the Internet

Environment variable names and purposes only. **Never commit values.**

| Name | Purpose |
|------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for `AnthropicBrain`. Required when `NPC_BRAIN_PROVIDER` is unset or `anthropic`. Exactly one of this or `ANTHROPIC_API_KEY_FILE`. |
| `ANTHROPIC_API_KEY_FILE` | In-container path to a file containing the Anthropic API key (trimmed). Prefer over env so the token is not visible in `docker inspect`. |
| `ANTHROPIC_API_KEY_HOST_PATH` | Host path bind-mounted read-only to `/run/secrets/anthropic_api_key` when using file-based Anthropic secrets. |
| `NPC_BRAIN_PROVIDER` | Brain implementation: `anthropic` (default when unset), `openai-compat`, or `fake` (tests only). |
| `NPC_BRAIN_BASE_URL` | OpenAI-compatible API origin (no trailing slash required). Required when `NPC_BRAIN_PROVIDER=openai-compat`. Recommended: `https://openrouter.ai/api/v1`. |
| `NPC_BRAIN_API_KEY` | API key for `OpenAICompatBrain`. Required when `NPC_BRAIN_PROVIDER=openai-compat`. Exactly one of this or `NPC_BRAIN_API_KEY_FILE`. |
| `NPC_BRAIN_API_KEY_FILE` | In-container path to the openai-compat API key file (trimmed). |
| `NPC_BRAIN_API_KEY_HOST_PATH` | Host path bind-mounted read-only to `/run/secrets/brain_api_key` when using file-based openai-compat secrets. |
| `NPC_BRAIN_MODEL` | Model id. Required for openai-compat (no code default). Anthropic default: `claude-sonnet-4-20250514`. |
| `NPC_BRAIN_MAX_TOKENS` | Default max output tokens per Brain completion (default: `1024`). |
| `NPC_BRAIN_TIMEOUT_MS` | HTTP timeout in milliseconds for Brain API requests (default: `60000`). |
| `NPC_BRAIN_PROVIDER_ALLOWLIST` | Comma-separated OpenRouter provider slugs. **Required and non-empty** when `NPC_BRAIN_BASE_URL` host is `openrouter.ai`. Documented Ghost example: `fireworks,together,deepinfra`. |
| `NPC_QUARANTINE_WINDOW_MS` | Milliseconds a distillation candidate must ripen before commit to `memory.shard` (default: `86400000` — 24 hours). Runtime env; not yet wired in Ghost compose. |
| `NPC_IMAGE_TAG` | Docker image tag for all Ghost stack services (default: `latest`). Set to `local` when using locally built images. |
| `NPC_CONTAINER_UID` | Container user id for `npc` in all Ghost images (fixed `10001`). Host `keys/` and `rclone/` bind mounts must be owned by this uid. Not a secret — documented constant. |
| `NPC_CONTAINER_GID` | Container group id for `npc` in all Ghost images (fixed `10001`). Same ownership requirement for host bind mounts. Not a secret — documented constant. |
| `SOUL_KEY_HOST_PATH` | Host filesystem path to the soul private key file mounted read-only into runtime at `/run/keys/soul.key`. |
| `DOOR_KEY_HOST_PATH` | Host filesystem path to the door private key file mounted read-only into door-discord at `/run/keys/door.key`. |
| `RCLONE_CONFIG_HOST_PATH` | Host directory containing `rclone.conf`, mounted read-only into the backup sidecar at `/config/rclone`. |
| `SOUL_KEY_PATH` | In-container path to the Wanderer soul private key (compose sets `/run/keys/soul.key`). |
| `SOULCHAIN_DIR` | In-container soulchain directory for runtime (compose sets `/data/soulchain`). |
| `ATLAS_CHAIN_DIR` | Filesystem path to the soulchain directory read by the Atlas API (`chain.jsonl` + `blobs/`). |
| `ATLAS_PORT` | TCP port for the Atlas read API HTTP server (default: `8787`). |
| `ATLAS_DOOR_PUBKEYS` | Comma-separated `doorId=base64url` Ed25519 **public** door key bindings for cosignature verification (public config, not secret). Example: `discord:123456789012345678=keyB64`. Passed to runtime for chain verify and to atlas-api. |
| `CURRENT_DOOR_ID` | Door id of the active residency (public config, not secret). Ghost compose derives `discord:${DISCORD_GUILD_ID}`; must match the Door hello response. |
| `DISCORD_BOT_TOKEN` | Discord bot token for `@npc/door-discord`. Exactly one of this or `DISCORD_BOT_TOKEN_FILE`. |
| `DISCORD_BOT_TOKEN_FILE` | In-container path to a file containing the Discord bot token (trimmed). |
| `DISCORD_BOT_TOKEN_HOST_PATH` | Host path bind-mounted read-only to `/run/secrets/discord_bot_token` when using file-based secrets. |
| `DOOR_KEY_PATH` | In-container path to the Door Ed25519 private key file (compose sets `/run/keys/door.key`). |
| `SOUL_PUBLIC_KEY` | Wanderer soul Ed25519 public key (base64url) for Door session verification (public config). |
| `DISCORD_GUILD_ID` | Discord guild snowflake bound to this Door (public config). |
| `DISCORD_CHANNEL_ID` | Discord channel snowflake for residency relay (public config). |
| `DISCORD_OPERATOR_IDS` | Comma-separated Discord user snowflakes allowed to cosign/status (public config). |
| `DISCORD_REVIEW_TIMEOUT_MS` | Cosign review wait; timeout rejects shards (default `300000`). |
| `DISCORD_REVIEW_CHANNEL_ID` | Optional Discord channel snowflake for cosign review posts; when unset, falls back to `DISCORD_CHANNEL_ID`. |
| `DISCORD_USER_RATE_PER_MIN` | Per-user message rate limit (messages per minute, default `20`). |
| `DISCORD_USER_BURST` | Per-user burst allowance before rate limiting (default `5`). |
| `DISCORD_CHANNEL_RATE_PER_MIN` | Per-channel message rate limit (messages per minute, default `60`). |
| `DISCORD_CHANNEL_BURST` | Per-channel burst allowance before rate limiting (default `15`). |
| `DISCORD_COMMUNITY_NAME` | Human-readable community name advertised by the Door (public config). |
| `DISCORD_COMMUNITY_DESCRIPTION` | Short community description for the Door (public config). |
| `DOOR_HTTP_HOST` / `DOOR_HTTP_PORT` | Door **listen** address for REST + WebSocket on a single coalesced port. door-discord binds `0.0.0.0:9090` in Ghost compose. runtime **connects** to `door-discord:9090` on the internal Docker network. Not published to the host by default. |
| `NPC_RUNTIME_READY_FILE` | Path written when the residency WebSocket is live (default `/tmp/npc-runtime.ready`). Used by compose healthcheck; optional override. |
| `NPC_REPLICATION_ENABLED` | Set to `1` or `true` to enable outbound IPFS replication drain in runtime. Default unset (disabled). Empty target set is safe — no push until targets are configured. Gate 2 before live tokens. |
| `NPC_REPLICATION_TARGETS` | JSON array of replication targets: `{name, kind: "car-upload", endpoint, tokenEnv}`. Default `[]`. Names match `[a-z0-9_-]+`. |
| `NPC_REPLICATION_DRAIN_INTERVAL_MS` | Milliseconds between replication drain ticks (default `15000`). |
| `NPC_SOULCHAIN_IPFS_DIR` | In-container IpfsSoulStore directory for dual-write (`DualSoulStore`). Required when replication is enabled. Compose sets `/data/soulchain-ipfs`. |
| `NPC_PUBLISHED_CAR_PATH` | Path where runtime writes the latest soulchain CAR for Atlas download (default `/data/published/soulchain-latest.car`). |
| `NPC_MANIFEST_CID_PATH` | Sidecar text file with the latest published manifest CID (default `/data/published/manifest-cid.txt`). |
| `STORACHA_TOKEN` | Bearer token for Storacha CAR upload (`tokenEnv` in `NPC_REPLICATION_TARGETS`). Exactly one of this or `STORACHA_TOKEN_FILE`. |
| `STORACHA_TOKEN_FILE` | In-container path to Storacha token file. |
| `FILEBASE_TOKEN` | Bearer token for Filebase CAR upload (`tokenEnv` in `NPC_REPLICATION_TARGETS`). Exactly one of this or `FILEBASE_TOKEN_FILE`. |
| `FILEBASE_TOKEN_FILE` | In-container path to Filebase token file. |
| `BACKUP_SOURCE_DIR` | In-container soulchain directory watched by the backup sidecar (compose sets `/data/soulchain`). |
| `BACKUP_RCLONE_REMOTE` | rclone remote path for soulchain backup (e.g. `ghost-remote:npc/soulchain`). Required for backup sidecar. |
| `BACKUP_DEBOUNCE_SEC` | Seconds to wait after a change before syncing (default `5`). |
| `BACKUP_INTERVAL_SEC` | Periodic safety sync interval in seconds (default `300`). |
| `ALLOW_CHAIN_SHRINK` | Ops override: set to `1` only intentionally to allow uploading a smaller `chain.jsonl` than the remote tip. Default unset (refuse size regression). |
| `BACKUP_OK_PATH` | Filesystem path touched after a successful backup cycle (default `/tmp/backup.ok`). Ghost compose healthcheck requires the marker to be newer than 900s. |
| `RCLONE_CONFIG` | In-container path to rclone config file (compose sets `/config/rclone/rclone.conf`). |
| `RCLONE_CACHE_DIR` | rclone cache directory (compose sets `/tmp/rclone-cache` under tmpfs for read-only rootfs). |
| `AGE_RECIPIENT` | age recipient public key for encrypted `soul.key`/`door.key` backup (`ops/scripts/key-backup.sh`). Host-only. |
| `AGE_IDENTITY_PATH` | Path to age identity file for decrypt drills (`ops/scripts/key-backup-drill.sh` / restore). Never commit; never mount into containers. |
| `KEY_BACKUP_RCLONE_REMOTE` | rclone remote path for encrypted key backup (e.g. `ghost-keys:npc/keys`). **Must differ** from `BACKUP_RCLONE_REMOTE`. |
| `KEY_BACKUP_RCLONE_CONFIG` | Optional path to a separate `rclone.conf` (different B2 app key) for key backup. |
| `NPC_KEY_DRILL_LIVE` | Set to `1` to force live key-backup drill (decrypt remote `latest/` and cmp host keys). Set to `0` to force offline fixture mode even if `AGE_IDENTITY_PATH` is set. |
| `NPC_COMPOSE_SECRETS` | When `1`, `ghostc` also loads `ops/compose.secrets.yml` (bind-mounts `*_HOST_PATH` secrets). |

## OpenRouter account hardening

When `NPC_BRAIN_BASE_URL` is OpenRouter, the runtime sends `provider.only` from `NPC_BRAIN_PROVIDER_ALLOWLIST` on every completion so requests cannot fall through to China-hosted first-party endpoints (the allowlist is the auditable guarantee). Back that up in the OpenRouter account:

- Set **data collection** to **deny**.
- Do **not** enable routing to DeepSeek first-party (or other non-allowlisted hosts).
- Cap prepaid credits / spend in the OpenRouter dashboard (Treasury-lite sleep-on-broke is a later issue).

The documented allowlist (`fireworks,together,deepinfra`) is US-headquartered. DeepInfra states US data centers. Fireworks' serverless fleet is multi-region — region-suffixed OpenRouter slugs are out of scope for T7.11; file a follow-up if residency requires pinning a US region suffix.
