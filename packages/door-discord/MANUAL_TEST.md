# Manual test — Discord Door (real server)

End-to-end walkthrough for a human or agent with Discord access. CI does **not** run this.

> **Note:** Production `wanderer move` CLI Door transport wiring lands with T6.1. This package ships an in-process residency harness (`pnpm --filter @npc/door-discord manual-residency`) that uses the same `Session` + adapter Door path as the integration test, against a live Discord channel.

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
pnpm --filter @npc/osp-cli exec osp verify --dir "$SOULCHAIN_DIR"
```

Expect a valid chain with `memory.candidate` records from depart (not committed `memory.shard` until a later quarantine commit).

## 6. Production adapter only (no Session)

```bash
pnpm --filter @npc/door-discord start
```

Starts Discord + `HttpDoorServer` / `WsDoorSessionServer` for T6.1 compose. Runtime Door HTTP client wiring is out of scope for T4.2.
