import { readFileSync } from "node:fs";

import { loadWitnessConfig, WitnessConfigError, type WitnessConfig } from "@npc/door-sdk";
import { decodePublicKey } from "@npc/osp-core";
import { z } from "zod";

import { DiscordDoorError } from "./errors.js";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 9090;
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
  userRatePerMinute: z.number().int().positive(),
  userBurst: z.number().int().positive(),
  channelRatePerMinute: z.number().int().positive(),
  channelBurst: z.number().int().positive(),
  communityName: z.string().min(1).max(200),
  communityDescription: z.string().min(1).max(2000),
  presenceNotices: z.boolean()
});

/** Validated Discord Door configuration loaded from environment variables. */
export type DiscordDoorConfig = z.infer<typeof discordDoorConfigSchema> & {
  /** Memory witness model settings (`loadWitnessConfig`); `null` = this Door witnesses no memories. */
  witness: WitnessConfig;
};

/**
 * Door id on the wire for this guild (`discord:<guild-id>`, no `door:` prefix).
 */
export function doorIdForGuild(guildId: string): string {
  return `discord:${guildId}`;
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * Read a secret from a file path named by a `*_FILE` env var.
 * Error messages name the env var and path only — never secret values.
 */
function readSecretFromFile(path: string, fileVarName: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new DiscordDoorError(
      "invalid_config",
      `failed to read ${fileVarName} at ${path}: ${detail}`
    );
  }

  const trimmed = contents.trim();
  if (trimmed === "") {
    throw new DiscordDoorError("invalid_config", `${fileVarName} at ${path} is empty`);
  }

  return trimmed;
}

/**
 * Resolve a secret from either a direct env var or a companion `*_FILE` path.
 * Exactly one must be set (non-empty).
 */
function resolveSecretFromEnv(env: NodeJS.ProcessEnv, name: string, fileName: string): string {
  const direct = env[name];
  const filePath = env[fileName];
  const hasDirect = isEnvSet(direct);
  const hasFile = isEnvSet(filePath);

  if (hasDirect && hasFile) {
    throw new DiscordDoorError("invalid_config", `set only one of ${name} or ${fileName}`);
  }
  if (!hasDirect && !hasFile) {
    throw new DiscordDoorError("invalid_config", `${name} is required but not set`);
  }

  if (hasFile && filePath !== undefined) {
    return readSecretFromFile(filePath, fileName);
  }

  if (direct !== undefined) {
    return direct;
  }

  throw new DiscordDoorError("invalid_config", `${name} is required but not set`);
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

function parseFlag(value: string | undefined, fallback: boolean, name: string): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "") {
    return fallback;
  }
  if (normalized === "1" || normalized === "true" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "off") {
    return false;
  }
  throw new DiscordDoorError("invalid_config", `${name} must be 0 or 1 (got ${value ?? ""})`);
}

/** Witness settings via door-sdk; a partial/invalid witness config is a config error. */
function loadWitness(env: NodeJS.ProcessEnv): WitnessConfig {
  try {
    return loadWitnessConfig(env);
  } catch (error: unknown) {
    if (error instanceof WitnessConfigError) {
      throw new DiscordDoorError("invalid_config", error.message, error);
    }
    throw error;
  }
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
 * Required: `DISCORD_BOT_TOKEN` or `DISCORD_BOT_TOKEN_FILE` (exactly one),
 * `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`,
 * `DISCORD_OPERATOR_IDS`, `DOOR_KEY_PATH`, `SOUL_PUBLIC_KEY`.
 *
 * Memory witness: `DOOR_WITNESS_*` (falling back to `NPC_BRAIN_*`; `DOOR_WITNESS=off`
 * disables) via door-sdk `loadWitnessConfig`. Unconfigured = no witness, so the Wanderer
 * forms no memories here; a partial or invalid witness config throws `invalid_config`.
 *
 * Presence notices: `DISCORD_PRESENCE_NOTICES` (default on; `0` disables the
 * arrived / moved-on posts in the residency channel).
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object in tests.
 */
export function loadDiscordDoorConfig(env: NodeJS.ProcessEnv = process.env): DiscordDoorConfig {
  const botToken = resolveSecretFromEnv(env, "DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN_FILE");
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
  const communityName =
    env.DISCORD_COMMUNITY_NAME === undefined || env.DISCORD_COMMUNITY_NAME === ""
      ? DEFAULT_COMMUNITY_NAME
      : env.DISCORD_COMMUNITY_NAME;
  const communityDescription =
    env.DISCORD_COMMUNITY_DESCRIPTION === undefined || env.DISCORD_COMMUNITY_DESCRIPTION === ""
      ? DEFAULT_COMMUNITY_DESCRIPTION
      : env.DISCORD_COMMUNITY_DESCRIPTION;

  const witness = loadWitness(env);

  const result = discordDoorConfigSchema.safeParse({
    botToken,
    guildId,
    channelId,
    operatorIds,
    doorKeyPath,
    soulPublicKey,
    httpHost,
    httpPort,
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
    communityDescription,
    presenceNotices: parseFlag(env.DISCORD_PRESENCE_NOTICES, true, "DISCORD_PRESENCE_NOTICES")
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new DiscordDoorError("invalid_config", `Invalid Discord Door configuration: ${detail}`);
  }

  return { ...result.data, witness };
}
