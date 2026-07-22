# @npc/door-discord

Discord Door adapter: one guild channel becomes a Door. Wraps `@npc/door-sdk` `Door` with Discord-native host policy (relay, rate limits, `/wanderer` commands, cosign review).

## Public API

- **`startDiscordDoor(options)`** — boot Door HTTP/WS servers (optional), Discord gateway, review gate, and channel relay
- **`loadDiscordDoorConfig(env)`** — Zod-validated env config (inject `env` in tests)
- **`DiscordGateway`** — thin seam over discord.js (`DiscordJsGateway` in prod; `FakeGateway` in tests)
- **`ReviewGate` / `ReviewGatedDoor`** — async host approval before sync `decideShard` (timeout → **rejected**)

## Config (env)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `DISCORD_GUILD_ID` | yes | Bound guild (also forms `door_id` = `discord:<guild-id>`) |
| `DISCORD_CHANNEL_ID` | yes | Bound text channel |
| `DISCORD_OPERATOR_IDS` | yes | Comma-separated operator user ids |
| `DOOR_KEY_PATH` | yes | Path to door Ed25519 private key (32 raw bytes or base64url) |
| `SOUL_PUBLIC_KEY` | yes | Wanderer soul public key (base64url) |
| `DISCORD_REVIEW_TIMEOUT_MS` | no | Cosign review wait (default `300000`). **Timeout rejects.** |
| `DISCORD_REVIEW_CHANNEL_ID` | no | Alternate channel/thread for review posts |
| `DOOR_HTTP_HOST` / `DOOR_HTTP_PORT` | no | Door REST listen (default `127.0.0.1:9090`) |
| `DISCORD_USER_RATE_PER_MIN` / `DISCORD_USER_BURST` | no | Per-user inbound token bucket |
| `DISCORD_CHANNEL_RATE_PER_MIN` / `DISCORD_CHANNEL_BURST` | no | Per-channel inbound token bucket |

See `ops/SECRETS.md` for secret names only.

## Run

```bash
pnpm --filter @npc/door-discord build
pnpm --filter @npc/door-discord start
```

Real-server walkthrough: [MANUAL_TEST.md](./MANUAL_TEST.md).

## Test

```bash
pnpm --filter @npc/door-discord test
```

CI uses `FakeGateway` (no discord.js network). Integration test runs a full residency against `@npc/runtime` `Session` + `FakeBrain`.
