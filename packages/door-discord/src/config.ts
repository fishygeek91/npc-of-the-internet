import { decodePublicKey } from "@npc/osp-core";
import { z } from "zod";

import { DiscordDoorError } from "./errors.js";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 9090;
const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
const DEFAULT_USER_RATE_PER_MIN = 20;
const DEFAULT_USER_BURST = 5;
const DEFAULT_CHANNEL_RATE_PER_MIN = 60;
const DEFAULT_CHANNEL_BURST = 15;
const DEFAULT_COMMUNITY_NAME = "Discord Door";
const DEFAULT_COMMUNITY_DESCRIPTION = "A Discord channel hosting the Wanderer.";

const snowflakeSchema = z.string().regex(/^\d{5,32}$/, "must be a Discord snowflake id");

const discordDoorConfigSchema = z.object({
  botToken: z.string().min(1, "DISCORD_BOT_TOKEN must be a non-empty string"),
  guildId: snowflakeSchema,
  channelId: snowflakeSchema,
  operatorIds: z.array(snowflakeSchema).min(1, "DISCORD_OPERATOR_IDS must list at least one id"),
  doorKeyPath: z.string().min(1, "DOOR_KEY_PATH must be a non-empty string"),
  soulPublicKey: z.instanceof(Uint8Array),
  httpHost: z.string().min(1),
  httpPort: z.number().int().positive(),
  reviewTimeoutMs: z.number().int().positive(),
  reviewChannelId: snowflakeSchema.optional(),
  userRatePerMinute: z.number().int().positive(),
  userBurst: z.number().int().positive(),
  channelRatePerMinute: z.number().int().positive(),
  channelBurst: z.number().int().positive(),
  communityName: z.string().min(1).max(200),
  communityDescription: z.string().min(1).max(2000)
});

/** Validated Discord Door configuration loaded from environment variables. */
export type DiscordDoorConfig = z.infer<typeof discordDoorConfigSchema>;

/**
 * Door id on the wire for this guild (`discord:<guild-id>`, no `door:` prefix).
 */
export function doorIdForGuild(guildId: string): string {
  return `discord:${guildId}`;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new DiscordDoorError("invalid_config", `${name} is required but not set`);
  }
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DiscordDoorError(
      "invalid_config",
      `${name} must be a positive integer (got ${value})`
    );
  }

  return parsed;
}

function parseOperatorIds(raw: string): string[] {
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (ids.length === 0) {
    throw new DiscordDoorError(
      "invalid_config",
      "DISCORD_OPERATOR_IDS must list at least one operator user id"
    );
  }

  return ids;
}

function parseSoulPublicKey(raw: string): Uint8Array {
  try {
    return decodePublicKey(raw.trim());
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid encoding";
    throw new DiscordDoorError(
      "invalid_config",
      `SOUL_PUBLIC_KEY must be a base64url Ed25519 public key: ${detail}`
    );
  }
}

/**
 * Load and validate Discord Door configuration from environment variables.
 *
 * Required: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`,
 * `DISCORD_OPERATOR_IDS`, `DOOR_KEY_PATH`, `SOUL_PUBLIC_KEY`.
 *
 * Review timeout default rejects on expiry (safe default — a host who ignores
 * review must not silently endorse memories).
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object in tests.
 */
export function loadDiscordDoorConfig(env: NodeJS.ProcessEnv = process.env): DiscordDoorConfig {
  const botToken = requireEnv(env, "DISCORD_BOT_TOKEN");
  const guildId = requireEnv(env, "DISCORD_GUILD_ID");
  const channelId = requireEnv(env, "DISCORD_CHANNEL_ID");
  const operatorIds = parseOperatorIds(requireEnv(env, "DISCORD_OPERATOR_IDS"));
  const doorKeyPath = requireEnv(env, "DOOR_KEY_PATH");
  const soulPublicKey = parseSoulPublicKey(requireEnv(env, "SOUL_PUBLIC_KEY"));

  const httpHost =
    env.DOOR_HTTP_HOST === undefined || env.DOOR_HTTP_HOST === ""
      ? DEFAULT_HTTP_HOST
      : env.DOOR_HTTP_HOST;
  const httpPort = parsePositiveInt(env.DOOR_HTTP_PORT, DEFAULT_HTTP_PORT, "DOOR_HTTP_PORT");
  const reviewTimeoutMs = parsePositiveInt(
    env.DISCORD_REVIEW_TIMEOUT_MS,
    DEFAULT_REVIEW_TIMEOUT_MS,
    "DISCORD_REVIEW_TIMEOUT_MS"
  );

  const reviewChannelRaw = env.DISCORD_REVIEW_CHANNEL_ID;
  const reviewChannelId =
    reviewChannelRaw === undefined || reviewChannelRaw === "" ? undefined : reviewChannelRaw;

  const communityName =
    env.DISCORD_COMMUNITY_NAME === undefined || env.DISCORD_COMMUNITY_NAME === ""
      ? DEFAULT_COMMUNITY_NAME
      : env.DISCORD_COMMUNITY_NAME;
  const communityDescription =
    env.DISCORD_COMMUNITY_DESCRIPTION === undefined || env.DISCORD_COMMUNITY_DESCRIPTION === ""
      ? DEFAULT_COMMUNITY_DESCRIPTION
      : env.DISCORD_COMMUNITY_DESCRIPTION;

  const result = discordDoorConfigSchema.safeParse({
    botToken,
    guildId,
    channelId,
    operatorIds,
    doorKeyPath,
    soulPublicKey,
    httpHost,
    httpPort,
    reviewTimeoutMs,
    ...(reviewChannelId === undefined ? {} : { reviewChannelId }),
    userRatePerMinute: parsePositiveInt(
      env.DISCORD_USER_RATE_PER_MIN,
      DEFAULT_USER_RATE_PER_MIN,
      "DISCORD_USER_RATE_PER_MIN"
    ),
    userBurst: parsePositiveInt(env.DISCORD_USER_BURST, DEFAULT_USER_BURST, "DISCORD_USER_BURST"),
    channelRatePerMinute: parsePositiveInt(
      env.DISCORD_CHANNEL_RATE_PER_MIN,
      DEFAULT_CHANNEL_RATE_PER_MIN,
      "DISCORD_CHANNEL_RATE_PER_MIN"
    ),
    channelBurst: parsePositiveInt(
      env.DISCORD_CHANNEL_BURST,
      DEFAULT_CHANNEL_BURST,
      "DISCORD_CHANNEL_BURST"
    ),
    communityName,
    communityDescription
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new DiscordDoorError("invalid_config", `Invalid Discord Door configuration: ${detail}`);
  }

  return result.data;
}
