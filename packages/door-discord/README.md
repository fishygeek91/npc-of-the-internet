# @npc/door-discord

Discord Door adapter: one guild channel becomes a Door. Wraps the `@npc/door-sdk` `Door` (`door/0.2`) with Discord-native host policy: channel relay, rate limits, `/wanderer status`, presence notices, and the Door's AI memory witness.

## Public API

- **`startDiscordDoor(options)`** — boot the Door (with the memory witness when configured), HTTP/WS servers (optional), Discord gateway, channel relay, and presence notices. `options.witness` overrides the witness (tests).
- **`loadDiscordDoorConfig(env)`** — Zod-validated env config (inject `env` in tests)
- **`DiscordGateway`** — thin seam over discord.js (`DiscordJsGateway` in prod; `FakeGateway` in tests)
- **`formatStatusReply` / `DoorStatusSnapshot`** — the ephemeral `/wanderer status` reply (presence, door id, epoch, session, whether memories are witnessed)

## Memory witness

No human approves memories. When the Wanderer departs, it sends each memory (shard or journal) as `attest` kind `memory`; this Door's AI witness (`createAiWitness` from `@npc/door-sdk`) judges it against the Door's own in-memory record of the stay (community messages relayed in, Wanderer messages posted out) and the Door co-signs it — witnessed memories are final immediately. A decline (`witness_declined`) is final; a witness outage is `witness_unavailable` and the Wanderer retries later.

The witness model is configured with `DOOR_WITNESS_*` env (each falling back to `NPC_BRAIN_*`, so a Door beside the runtime needs no extra setup). With no witness configured (or `DOOR_WITNESS=off`) the Door does not advertise `attest.memory` and the Wanderer forms no memories here. A partial or invalid witness config fails boot (`invalid_config`). Boot logs `door_witness_config { enabled, model }` (never the key).

## Presence notices

The Wanderer is in one place at a time. The adapter posts in the bound channel when it arrives (`✨ The Wanderer has arrived.`) and when it departs (`🌫️ The Wanderer has moved on.`). A restart (a newer epoch superseding the live one) posts nothing. A failed post logs `presence_notice_failed` and never affects the protocol. `DISCORD_PRESENCE_NOTICES=0` turns them off.

## Config (env)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_BOT_TOKEN` | yes* | Bot token (direct) |
| `DISCORD_BOT_TOKEN_FILE` | yes* | Path to file containing the bot token (trimmed) |
| `DISCORD_GUILD_ID` | yes | Bound guild (also forms `door_id` = `discord:<guild-id>`) |
| `DISCORD_CHANNEL_ID` | yes | Bound text channel |
| `DISCORD_OPERATOR_IDS` | yes | Comma-separated operator user ids |
| `DOOR_KEY_PATH` | yes | Path to door Ed25519 private key (32 raw bytes or base64url) |
| `SOUL_PUBLIC_KEY` | yes | Wanderer soul public key (base64url) |
| `DOOR_HTTP_HOST` / `DOOR_HTTP_PORT` | no | Door REST + WebSocket session listen (default `127.0.0.1:9090`; WS path `/door/session`) |
| `DISCORD_USER_RATE_PER_MIN` / `DISCORD_USER_BURST` | no | Per-user inbound token bucket |
| `DISCORD_CHANNEL_RATE_PER_MIN` / `DISCORD_CHANNEL_BURST` | no | Per-channel inbound token bucket |
| `DISCORD_PRESENCE_NOTICES` | no | `0` disables the arrived / moved-on posts (default `1`) |
| `DOOR_WITNESS` | no | `off` disables the memory witness |
| `DOOR_WITNESS_BASE_URL` / `DOOR_WITNESS_MODEL` | no | Witness OpenAI-compatible endpoint + model (fallback `NPC_BRAIN_BASE_URL` / `NPC_BRAIN_MODEL`) |
| `DOOR_WITNESS_API_KEY` / `DOOR_WITNESS_API_KEY_FILE` | no | Witness API key, inline or file (fallback `NPC_BRAIN_API_KEY` / `NPC_BRAIN_API_KEY_FILE`) |
| `DOOR_WITNESS_PROVIDER_ALLOWLIST` / `DOOR_WITNESS_TIMEOUT_MS` | no | OpenRouter provider allowlist (fallback `NPC_BRAIN_PROVIDER_ALLOWLIST`); per-call timeout (default `60000`) |

\* Set exactly one of `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE` (non-empty).

See `ops/SECRETS.md` for secret names only.

## Attention & actions (`session.addressing`, `session.reactions`)

- **Addressing:** inbound frames carry `addressed: true` when the message @mentions the bot (or reply-pings it) or is a Discord reply to one of the Wanderer's messages. The relay shows a best-effort "typing…" indicator for addressed messages.
- **Mentions:** `<@id>` / `<@&id>` / `<#id>` tokens are rendered as plain names (bot → `Wanderer`, users → display name, `#channel`), and `@everyone`/`@here` lose the `@`. `@name` text would trip the runtime immune `pii.handle` screen and drop the whole message.
- **No pings:** every bot message (relay, presence and operator notices, ephemeral replies) is sent with `allowedMentions: { parse: [], repliedUser: false }` (also the client default), so Wanderer/LLM text containing `@everyone`, `@here`, role or user mentions never notifies anyone, and replies don't ping the author.
- **Length:** Discord caps messages at 2000 chars (protocol allows 4000): outbound text is split on newline/space boundaries (never inside a surrogate pair); only the first chunk is a reply. Replies use `failIfNotExists: false`, so a deleted parent posts without a reference.
- **Ids:** the relay keeps a bounded (1000) msg_id ↔ Discord id map, so outbound `reply_to` becomes a real Discord reply and `reaction.target_msg_id` resolves to the right message. Inbound `reply_to` is the parent's protocol msg_id when known. The map is per epoch (the runtime's `out-N` ids restart each session); the set of the Wanderer's own message ids (for addressing) survives epochs and is bounded separately.
- **Reactions:** outbound `reaction: { emoji, target_msg_id }` → `message.react(emoji)` (needs the **Add Reactions** permission). A failed reaction logs `reaction_failed` and never posts an operator notice.
- **Silence:** the runtime (selective mode) may not answer at all — that is the design.

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

CI uses `FakeGateway` (no discord.js network). Witness and presence tests drive the Door with hand-signed attests and a fake witness; integration tests run a full residency against `@npc/runtime` `Session` + `FakeBrain`.
