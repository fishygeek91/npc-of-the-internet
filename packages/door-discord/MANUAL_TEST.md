# Manual test — Discord Door (real server)

End-to-end walkthrough for a human or agent with Discord access. CI does **not** run this.

> **Note:** Production cross-container residency uses `npc-runtime` in the Ghost compose stack (T6.1-followup, issue #53). This package also ships an in-process residency harness (`pnpm --filter @npc/door-discord manual-residency`) that uses the same `Session` + adapter Door path as the integration test, against a live Discord channel.

## 1. Create the Discord bot

1. Open [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → Add Bot → reset token → copy into `DISCORD_BOT_TOKEN` (never commit).
3. Enable **Message Content Intent** (Bot → Privileged Gateway Intents).
4. OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Permissions: View Channels, Send Messages, Read Message History, Add Reactions, Use Slash Commands
5. Invite the bot to your guild; note **guild id** and the target **channel id** (Developer Mode → Copy ID).

## 2. Keys

```bash
# Door private key: 32 random bytes written raw, or base64url text
openssl rand 32 > /tmp/door.key
chmod 600 /tmp/door.key

# Soul public key: base64url of the Wanderer soul pubkey used by your local chain
# (must match genesis soul_pubkey). Export however you generated the soul key.
```

## 3. Env

```bash
export DISCORD_BOT_TOKEN=...
export DISCORD_GUILD_ID=...
export DISCORD_CHANNEL_ID=...
export DISCORD_OPERATOR_IDS=...   # your Discord user id
export DOOR_KEY_PATH=/tmp/door.key
export SOUL_PUBLIC_KEY=...
export SOUL_KEY_PATH=...         # for the residency harness (soul private key)
export SOULCHAIN_DIR=./soulchain-data-manual
export DISCORD_REVIEW_TIMEOUT_MS=300000
# Timeout without ✅/❌ or /wanderer approve|reject REJECTS the shard (safe default).
```

Optional: `DISCORD_REVIEW_CHANNEL_ID` for a host-only review channel.

## 4. Run the adapter + residency harness

From repo root (built packages):

```bash
pnpm -r build
pnpm --filter @npc/door-discord manual-residency
```

What you should see:

1. Bot online in the guild.
2. `/wanderer status` → `presence: absent` before arrival, then `present` after the harness arrives.
3. Post a normal (non-bot) message in the bound channel → Wanderer replies (FakeBrain or Anthropic if `ANTHROPIC_API_KEY` is set — harness uses FakeBrain by default).
4. On depart, candidate shards are posted for review. React ✅/❌ as an allowlisted operator, or `/wanderer approve <shard_id>` / `/wanderer reject <shard_id>`.
5. Ignoring review until timeout **rejects** (documented safe default).

## 5. Verify the chain

```bash
pnpm --filter @npc/osp-cli exec osp verify "$SOULCHAIN_DIR"
```

Expect a valid chain with `memory.candidate` records from depart (not committed `memory.shard` until a later quarantine commit).

## 6. Production adapter only (no Session)

```bash
pnpm --filter @npc/door-discord start
```

Starts Discord + coalesced Door HTTP/WS on `DOOR_HTTP_HOST:DOOR_HTTP_PORT` (REST + `WS /door/session` on the same listener). Runtime connects via `@npc/door-sdk` HTTP/WS clients (`npc-runtime` in compose).

## 7. Cross-container Session (compose)

End-to-end check of **runtime ↔ door-discord** over the Ghost compose network on port **9090**.

### Prerequisites

1. Soul and door keys on the host (`ops/.env.example` paths or your overrides); `SOUL_PUBLIC_KEY` and `ATLAS_DOOR_PUBKEYS` match those keys.
2. `ops/.env` filled from `ops/.env.example` with a real `DISCORD_BOT_TOKEN`, guild/channel IDs, and `ANTHROPIC_API_KEY`.
3. Valid soulchain on the `soulchain` volume — run `osp init` into a staging dir and copy into the volume, or restore from backup (see `ops/RUNBOOK.md` §5). An empty volume prevents runtime from arriving.

### Start the stack

From repo root:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml up -d --build
```

### Confirm runtime is live

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs runtime 2>&1 | grep residency_live
docker compose --env-file ops/.env -f ops/compose.ghost.yml ps runtime
```

Expect log line `residency_live` and health status `healthy` (ready file at `/tmp/npc-runtime.ready`).

### Confirm door-discord listeners

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml logs door-discord 2>&1 | grep -E 'door_http_listening|door_ws_listening'
```

Both should report port **9090**.

### Discord round-trip

Post a normal (non-bot) message in the bound channel. The Wanderer should reply via the WebSocket session path (runtime → door-discord → Discord).

### Graceful stop (no auto-depart)

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml stop runtime
```

SIGTERM removes the ready file, closes the WS, drains appends, and releases `.append.lock`. It does **not** run ceremonial depart. Restart and confirm `residency_live` again:

```bash
docker compose --env-file ops/.env -f ops/compose.ghost.yml start runtime
```

If restart fails with a stale lock, see `ops/RUNBOOK.md` §6 (crash recovery).
