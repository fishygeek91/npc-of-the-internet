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
