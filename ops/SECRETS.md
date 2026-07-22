# Secrets — NPC of the Internet

Environment variable names and purposes only. **Never commit values.**

| Name | Purpose |
|------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for `AnthropicBrain` (runtime LLM completions). |
| `NPC_BRAIN_MODEL` | Claude model id for Brain completions (default: `claude-sonnet-4-20250514`). |
| `NPC_BRAIN_MAX_TOKENS` | Default max output tokens per Brain completion (default: `1024`). |
| `NPC_BRAIN_TIMEOUT_MS` | HTTP timeout in milliseconds for Anthropic API requests (default: `60000`). |
| `ATLAS_CHAIN_DIR` | Filesystem path to the soulchain directory read by the Atlas API (`chain.jsonl` + `blobs/`). |
| `ATLAS_PORT` | TCP port for the Atlas read API HTTP server (default: `8787`). |
| `ATLAS_DOOR_PUBKEYS` | Comma-separated base64url Ed25519 **public** door keys for cosignature verification (public config, not secret). |
| `SOUL_KEY_PATH` | Filesystem path to the Wanderer soul private key file (32-byte raw bytes or base64url text). |
| `DISCORD_BOT_TOKEN` | Discord bot token for `@npc/door-discord`. |
| `DOOR_KEY_PATH` | Filesystem path to the Door Ed25519 private key file (32-byte raw bytes or base64url text). |
| `SOUL_PUBLIC_KEY` | Wanderer soul Ed25519 public key (base64url) for Door session verification (public config). |
| `DISCORD_GUILD_ID` | Discord guild snowflake bound to this Door (public config). |
| `DISCORD_CHANNEL_ID` | Discord channel snowflake for residency relay (public config). |
| `DISCORD_OPERATOR_IDS` | Comma-separated Discord user snowflakes allowed to cosign/status (public config). |
| `DISCORD_REVIEW_TIMEOUT_MS` | Cosign review wait; timeout rejects shards (default `300000`). |
| `DOOR_HTTP_HOST` / `DOOR_HTTP_PORT` | Door REST/WS listen address for T6.1 (defaults `127.0.0.1` / `9090`). |
