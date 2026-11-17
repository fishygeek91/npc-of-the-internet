# Secrets — NPC of the Internet

Environment variable names and purposes only. **Never commit values.**

| Name | Purpose |
|------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for `AnthropicBrain`. Required when `NPC_BRAIN_PROVIDER` is unset or `anthropic`. Exactly one of this or `ANTHROPIC_API_KEY_FILE`. |
| `ANTHROPIC_API_KEY_FILE` | In-container path to a file containing the Anthropic API key (trimmed). Prefer over env so the token is not visible in `docker inspect`. |
| `ANTHROPIC_API_KEY_HOST_PATH` | Host path bind-mounted read-only to `/run/secrets/anthropic_api_key` when using file-based Anthropic secrets (overlay `ops/compose.secrets.anthropic.yml`). |
| `NPC_BRAIN_PROVIDER` | Brain implementation: `anthropic` (default when unset), `openai-compat`, or `fake` (tests only). |
| `NPC_BRAIN_BASE_URL` | OpenAI-compatible API origin (no trailing slash required). Required when `NPC_BRAIN_PROVIDER=openai-compat`. Recommended: `https://openrouter.ai/api/v1`. |
| `NPC_BRAIN_API_KEY` | API key for `OpenAICompatBrain`. Required when `NPC_BRAIN_PROVIDER=openai-compat`. Exactly one of this or `NPC_BRAIN_API_KEY_FILE`. |
| `NPC_BRAIN_API_KEY_FILE` | In-container path to the openai-compat API key file (trimmed). |
| `NPC_BRAIN_API_KEY_HOST_PATH` | Host path bind-mounted read-only to `/run/secrets/brain_api_key` when using file-based openai-compat secrets (overlay `ops/compose.secrets.yml`, production). |
| `NPC_BRAIN_MODEL` | Model id. Required for openai-compat (no code default). Anthropic default: `claude-sonnet-4-20250514`. |
| `NPC_BRAIN_MAX_TOKENS` | Default max output tokens per Brain completion (default: `1024`). |
| `NPC_BRAIN_TIMEOUT_MS` | HTTP timeout in milliseconds for Brain API requests (default: `60000`). |
| `NPC_BRAIN_PROVIDER_ALLOWLIST` | Comma-separated OpenRouter provider slugs. **Required and non-empty** when `NPC_BRAIN_BASE_URL` host is `openrouter.ai`. Documented Ghost example: `fireworks,together,deepinfra`. |
| `NPC_DOOR_URLS` | Comma-separated base URLs of every Door the Wanderer may travel between (public config). Ghost compose default: `http://door-discord:9090,http://door-web:9091`. Door ids come from each Door's verified `hello` and must be bound in `ATLAS_DOOR_PUBKEYS`. Unset = the single Door at `DOOR_HTTP_HOST:DOOR_HTTP_PORT` (legacy). |
| `NPC_RESIDENCY_OPERATOR_TRIGGER` | `1`/`true` (default) lets an operator start a residency cycle with `wanderer depart` (control-dir request) or `SIGUSR2` to the daemon; `0` turns it off. Public config, not secret. |
| `NPC_RESIDENCY_MAX_MS` | Travel once the live residency is older than this (checked every minute). Default `86400000` (daily); `0` = only on operator request; otherwise `≥ 3600000`. |
| `NPC_RESIDENCY_MIN_LINES` | A timer-triggered departure forms memories only when the stay's transcript holds at least this many lines (default `10`); a quieter stay still travels, without memories. Operator-requested departures need one line. |
| `NPC_CONTROL_DIR` | Directory the daemon polls for `wanderer depart` requests (default `/tmp/npc-control`; Ghost compose pins it on the `/tmp` tmpfs). |
| `NPC_JOURNAL_DIR` | Directory for residency journal markdown files written at departure (default `/data/published/journals`; Ghost compose pins it on the `published` volume). |
| `NPC_IMAGE_TAG` | Docker image tag for all Ghost stack services (default: `latest`). Set to `local` when using locally built images. |
| `NPC_CONTAINER_UID` | Container user id for `npc` in all Ghost images (fixed `10001`). Host `keys/` and `rclone/` bind mounts must be owned by this uid. Not a secret — documented constant. |
| `NPC_CONTAINER_GID` | Container group id for `npc` in all Ghost images (fixed `10001`). Same ownership requirement for host bind mounts. Not a secret — documented constant. |
| `SOUL_KEY_HOST_PATH` | Host filesystem path to the soul private key file mounted read-only into runtime at `/run/keys/soul.key`. |
| `DOOR_KEY_HOST_PATH` | Host filesystem path to the door private key file mounted read-only into door-discord **and** door-web at `/run/keys/door.key`. |
| `RCLONE_CONFIG_HOST_PATH` | Host directory containing `rclone.conf`, mounted read-only into the backup sidecar at `/config/rclone`. |
| `SOUL_KEY_PATH` | In-container path to the Wanderer soul private key (compose sets `/run/keys/soul.key`). |
| `SOULCHAIN_DIR` | In-container soulchain directory for runtime (compose sets `/data/soulchain`). |
| `ATLAS_CHAIN_DIR` | Filesystem path to the soulchain directory read by the Atlas API (`chain.jsonl` + `blobs/`). |
| `ATLAS_PORT` | TCP port for the Atlas read API HTTP server (default: `8787`). |
| `ATLAS_DOOR_PUBKEYS` | Comma-separated `doorId=base64url` Ed25519 **public** door key bindings (public config, not secret): the Doors the Wanderer trusts and whose co-signatures verify. One entry per Door id — Ghost needs both `discord:<guild id>=<door pubkey>` and `web:home=<same door pubkey>` (both Doors use `DOOR_KEY_HOST_PATH`). A Door whose `hello` is not bound here is skipped (`door_rejected`). Passed to runtime and atlas-api. |
| `CURRENT_DOOR_ID` | Boot preference only (public config): the Door to arrive at first when the chain names no last arrival or that Door is offline. Ghost compose derives `discord:${DISCORD_GUILD_ID}`. |
| `DISCORD_BOT_TOKEN` | Discord bot token for `@npc/door-discord`. Exactly one of this or `DISCORD_BOT_TOKEN_FILE`. |
| `DISCORD_BOT_TOKEN_FILE` | In-container path to a file containing the Discord bot token (trimmed). |
| `DISCORD_BOT_TOKEN_HOST_PATH` | Host path bind-mounted read-only to `/run/secrets/discord_bot_token` when using file-based secrets. |
| `DOOR_KEY_PATH` | In-container path to the Door Ed25519 private key file (compose sets `/run/keys/door.key`). |
| `SOUL_PUBLIC_KEY` | Wanderer soul Ed25519 public key (base64url) for Door session verification (public config). |
| `DISCORD_GUILD_ID` | Discord guild snowflake bound to this Door (public config). |
| `DISCORD_CHANNEL_ID` | Discord channel snowflake for residency relay (public config). |
| `DISCORD_OPERATOR_IDS` | Comma-separated Discord user snowflakes allowed to use operator slash commands such as `/wanderer status` (public config). |
| `DISCORD_PRESENCE_NOTICES` | `1` (default) posts "✨ The Wanderer has arrived." / "🌫️ The Wanderer has moved on." in the residency channel; `0` disables. Public config. |
| `DISCORD_USER_RATE_PER_MIN` | Per-user message rate limit (messages per minute, default `20`). |
| `DISCORD_USER_BURST` | Per-user burst allowance before rate limiting (default `5`). |
| `DISCORD_CHANNEL_RATE_PER_MIN` | Per-channel message rate limit (messages per minute, default `60`). |
| `DISCORD_CHANNEL_BURST` | Per-channel burst allowance before rate limiting (default `15`). |
| `DISCORD_COMMUNITY_NAME` | Human-readable community name advertised by the Door (public config). |
| `DISCORD_COMMUNITY_DESCRIPTION` | Short community description for the Door (public config). |
| `DOOR_HTTP_HOST` / `DOOR_HTTP_PORT` | Door protocol **listen** address for REST + WebSocket on a single coalesced port: door-discord `0.0.0.0:9090`, door-web `0.0.0.0:9091` in Ghost compose (internal network only, never published). The runtime reaches them via `NPC_DOOR_URLS`; it uses `DOOR_HTTP_HOST`/`DOOR_HTTP_PORT` itself only when `NPC_DOOR_URLS` is unset. |
| `DOOR_WITNESS` | `off` (or `0`/`false`) disables a Door's memory witness: it stops advertising `attest.memory` and the Wanderer forms no memories there. Unset = on when configured. Both Doors. |
| `DOOR_WITNESS_BASE_URL` | OpenAI-compatible API origin for the Door's memory witness. Falls back to `NPC_BRAIN_BASE_URL` when `NPC_BRAIN_PROVIDER=openai-compat`. |
| `DOOR_WITNESS_API_KEY` / `DOOR_WITNESS_API_KEY_FILE` | Witness API key (inline or in-container file path). Falls back to `NPC_BRAIN_API_KEY` / `NPC_BRAIN_API_KEY_FILE` only when the witness also uses the Brain's base URL — the Brain key is never sent to another host. `ops/compose.secrets.yml` mounts the Brain key file into both Doors. |
| `DOOR_WITNESS_MODEL` | Witness model id. Falls back to `NPC_BRAIN_MODEL` (openai-compat). |
| `DOOR_WITNESS_PROVIDER_ALLOWLIST` | OpenRouter `provider.only` slugs for the witness, comma-separated. Falls back to `NPC_BRAIN_PROVIDER_ALLOWLIST` only when the witness also uses the Brain's base URL. |
| `DOOR_WITNESS_TIMEOUT_MS` | Witness HTTP timeout per attempt, integer `1000`–`85000` (default `60000`; two attempts must finish inside the runtime's 180 s memory-attest timeout). |
| `DOOR_WEB_ID` | door-web Door id (default `web:home`); must be bound in `ATLAS_DOOR_PUBKEYS`. |
| `DOOR_WEB_COMMUNITY_NAME` / `DOOR_WEB_COMMUNITY_DESCRIPTION` | door-web page title/subtitle and `hello` community descriptor (public config). |
| `DOOR_WEB_PUBLIC_HOST` / `DOOR_WEB_PUBLIC_PORT` | door-web visitor-site listener (default `0.0.0.0:8080`; Ghost compose publishes it on `127.0.0.1:8080` only). |
| `DOOR_WEB_TRUST_PROXY` | `1` = door-web rate-limits by the last `X-Forwarded-For` hop (only behind your own proxy). Ghost compose default `1` (Caddy, `public` profile). |
| `DOOR_WEB_GLOBAL_PER_MIN` | Visitor messages per minute for all door-web visitors together (default `30`). |
| `DOOR_WEB_MAX_CLIENTS` | Max concurrent door-web SSE streams (default `200`). |
| `DOOR_WEB_DAILY_MAX` | Visitor messages relayed to the Wanderer per UTC day (default `1500`; bounds LLM cost — beyond it the porch answers `quiet_hours`). |
| `ATLAS_API_URL` | atlas-api base URL door-web uses to show where the Wanderer is while away (compose pins `http://atlas-api:8787`). |
| `WEB_DOMAIN` | Public hostname for the web Door (compose profile `public`: Caddy serves `https://$WEB_DOMAIN` → door-web). Needs a DNS A/AAAA record and ports 80/443 open. Public config. |
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
| `BACKUP_DEBOUNCE_SEC` | Seconds of quiet after a change before syncing; coalesces conversation bursts into one upload (default `30`). |
| `BACKUP_INTERVAL_SEC` | Periodic safety check interval in seconds (default `300`). Compares a local fingerprint of `blobs/` (set of names+sizes) + `chain.jsonl` with the last successful upload — **no remote calls unless something changed**. Keep below the 900s healthcheck window. |
| `BACKUP_VERIFY_SEC` | Full remote round-trip (checking `rclone copy` of all blobs, `lsjson` shrink guard, chain `copyto`, tombstone rescan) at least this often, so a revoked key, deleted bucket or lost object surfaces and self-heals (default `86400`). |
| `BACKUP_HEARTBEAT_DEFER_SEC` | When everything appended since the last uploaded chain is heartbeat attestations, defer the upload until this many seconds after the last successful chain upload (default `3600`; `0` disables). Any other record uploads after the debounce. The healthcheck stays green while deferring. |
| `BACKUP_HISTORY_SEC` | Minimum spacing of `history/<UTC>-<pid>/chain.jsonl` rollback points (default `86400` = daily). Intermediate tips are overwritten without a history copy; an `ALLOW_CHAIN_SHRINK=1` upload always snapshots. `0` = every upload (pre-2026-10 behavior). |
| `BACKUP_RETRY_SEC` | After a failed cycle (shrink refusal, rclone error, provider cap), retry an unchanged chain at most this often; new appends still retry immediately (default `900`). |
| `BACKUP_STATE_DIR` | Where the sidecar keeps its last-upload fingerprints (default `/tmp/backup-watch-state/<hash of source+remote>`). |
| `ALLOW_CHAIN_SHRINK` | Ops override: set to `1` only intentionally to allow uploading a smaller `chain.jsonl` than the remote tip. Default unset (refuse size regression). |
| `BACKUP_OK_PATH` | Filesystem path touched after a successful backup cycle (default `/tmp/backup.ok`). Ghost compose healthcheck requires the marker to be newer than 900s. |
| `RCLONE_CONFIG` | In-container path to rclone config file (compose sets `/config/rclone/rclone.conf`). |
| `RCLONE_CACHE_DIR` | rclone cache directory (compose sets `/tmp/rclone-cache` under tmpfs for read-only rootfs). |
| `AGE_RECIPIENT` | age recipient public key for encrypted `soul.key`/`door.key` backup (`ops/scripts/key-backup.sh`). Host-only. |
| `AGE_IDENTITY_PATH` | Path to age identity file for decrypt drills (`ops/scripts/key-backup-drill.sh` / restore). Never commit; never mount into containers. |
| `KEY_BACKUP_RCLONE_REMOTE` | rclone remote path for encrypted key backup (e.g. `ghost-keys:npc/keys`). **Must differ** from `BACKUP_RCLONE_REMOTE`. |
| `KEY_BACKUP_RCLONE_CONFIG` | Optional path to a separate `rclone.conf` (different B2 app key) for key backup. |
| `NPC_KEY_DRILL_LIVE` | Set to `1` to force live key-backup drill (decrypt remote `latest/` and cmp host keys). Set to `0` to force offline fixture mode even if `AGE_IDENTITY_PATH` is set. |
| `NPC_COMPOSE_SECRETS` | `1`: `ghostc` also loads `ops/compose.secrets.yml` (production openai-compat: bind-mounts `NPC_BRAIN_API_KEY_HOST_PATH` into runtime and both Doors' witnesses, + `DISCORD_BOT_TOKEN_HOST_PATH`). `anthropic`: loads `ops/compose.secrets.anthropic.yml` (`ANTHROPIC_API_KEY_HOST_PATH` + `DISCORD_BOT_TOKEN_HOST_PATH`). Each overlay fails fast if one of its host paths is unset. |

## OpenRouter account hardening

When `NPC_BRAIN_BASE_URL` is OpenRouter, the runtime sends `provider.only` from `NPC_BRAIN_PROVIDER_ALLOWLIST` on every completion so requests cannot fall through to China-hosted first-party endpoints (the allowlist is the auditable guarantee). Back that up in the OpenRouter account:

- Set **data collection** to **deny**.
- Do **not** enable routing to DeepSeek first-party (or other non-allowlisted hosts).
- Cap prepaid credits / spend in the OpenRouter dashboard (Treasury-lite sleep-on-broke is a later issue).

The documented allowlist (`fireworks,together,deepinfra`) is US-headquartered. DeepInfra states US data centers. Fireworks' serverless fleet is multi-region — region-suffixed OpenRouter slugs are out of scope for T7.11; file a follow-up if residency requires pinning a US region suffix.
