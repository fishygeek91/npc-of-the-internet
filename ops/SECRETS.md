# Secrets — NPC of the Internet

Environment variable names and purposes only. **Never commit values.**

| Name | Purpose |
|------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for `AnthropicBrain` (runtime LLM completions). |
| `NPC_BRAIN_MODEL` | Claude model id for Brain completions (default: `claude-sonnet-4-20250514`). |
| `NPC_BRAIN_MAX_TOKENS` | Default max output tokens per Brain completion (default: `1024`). |
| `NPC_BRAIN_TIMEOUT_MS` | HTTP timeout in milliseconds for Anthropic API requests (default: `60000`). |
| `NPC_QUARANTINE_WINDOW_MS` | Milliseconds a distillation candidate must ripen before commit to `memory.shard` (default: `86400000` — 24 hours). Runtime env; not yet wired in Ghost compose. |
| `NPC_IMAGE_TAG` | Docker image tag for all Ghost stack services (default: `latest`). Set to `local` when using locally built images. |
| `SOUL_KEY_HOST_PATH` | Host filesystem path to the soul private key file mounted read-only into runtime at `/run/keys/soul.key`. |
| `DOOR_KEY_HOST_PATH` | Host filesystem path to the door private key file mounted read-only into door-discord at `/run/keys/door.key`. |
| `RCLONE_CONFIG_HOST_PATH` | Host directory containing `rclone.conf`, mounted read-only into the backup sidecar at `/config/rclone`. |
| `SOUL_KEY_PATH` | In-container path to the Wanderer soul private key (compose sets `/run/keys/soul.key`). |
| `SOULCHAIN_DIR` | In-container soulchain directory for runtime (compose sets `/data/soulchain`). |
| `ATLAS_CHAIN_DIR` | Filesystem path to the soulchain directory read by the Atlas API (`chain.jsonl` + `blobs/`). |
| `ATLAS_PORT` | TCP port for the Atlas read API HTTP server (default: `8787`). |
| `ATLAS_DOOR_PUBKEYS` | Comma-separated base64url Ed25519 **public** door keys for cosignature verification (public config, not secret). Passed to runtime for chain verify and to atlas-api. |
| `CURRENT_DOOR_ID` | Door id of the active residency (public config, not secret). Ghost compose derives `discord:${DISCORD_GUILD_ID}`; must match the Door hello response. |
| `DISCORD_BOT_TOKEN` | Discord bot token for `@npc/door-discord`. |
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
| `BACKUP_SOURCE_DIR` | In-container soulchain directory watched by the backup sidecar (compose sets `/data/soulchain`). |
| `BACKUP_RCLONE_REMOTE` | rclone remote path for soulchain backup (e.g. `ghost-remote:npc/soulchain`). Required for backup sidecar. |
| `BACKUP_DEBOUNCE_SEC` | Seconds to wait after a change before syncing (default `5`). |
| `BACKUP_INTERVAL_SEC` | Periodic safety sync interval in seconds (default `300`). |
| `RCLONE_CONFIG` | In-container path to rclone config file (compose sets `/config/rclone/rclone.conf`). |
