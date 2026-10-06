import { decodePublicKey } from "@npc/osp-core";
import { z } from "zod";

import { WebDoorError } from "./errors.js";

const DEFAULT_DOOR_ID = "web:home";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_DOOR_HTTP_PORT = 9091;
const DEFAULT_PUBLIC_PORT = 8080;
const DEFAULT_MAX_CLIENTS = 200;
const DEFAULT_DAILY_MAX = 1500;
const DEFAULT_GLOBAL_PER_MIN = 30;
const DEFAULT_COMMUNITY_NAME = "The Wanderer's front porch";
const DEFAULT_COMMUNITY_DESCRIPTION =
  "A small public web page where anyone can talk with the Wanderer while it is here.";

/** Web Door ids are `web:<id>` (no `door:` prefix). */
const WEB_DOOR_ID_RE = /^web:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const portSchema = z.number().int().min(0).max(65535);

const webDoorConfigSchema = z.object({
  doorId: z.string().regex(WEB_DOOR_ID_RE, "DOOR_WEB_ID must look like web:<id>"),
  doorKeyPath: z.string().min(1, "DOOR_KEY_PATH must be a non-empty string"),
  soulPublicKey: z.instanceof(Uint8Array),
  doorHttpHost: z.string().min(1),
  doorHttpPort: portSchema,
  publicHost: z.string().min(1),
  publicPort: portSchema,
  communityName: z.string().min(1).max(200),
  communityDescription: z.string().min(1).max(2000),
  maxClients: z.number().int().positive(),
  globalPerMinute: z.number().int().positive(),
  dailyMax: z.number().int().positive(),
  trustProxy: z.boolean(),
  atlasApiUrl: z.string().url().optional()
});

/** Validated website Door configuration. */
export type WebDoorConfig = z.infer<typeof webDoorConfigSchema>;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = envValue(env, name);
  if (value === undefined) {
    throw new WebDoorError("invalid_config", `${name} is required but not set`);
  }
  return value;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envValue(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WebDoorError("invalid_config", `${name} must be a positive integer (got ${raw})`);
  }
  return parsed;
}

function parseSoulPublicKey(raw: string): Uint8Array {
  try {
    return decodePublicKey(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid encoding";
    throw new WebDoorError(
      "invalid_config",
      `SOUL_PUBLIC_KEY must be a base64url Ed25519 public key: ${detail}`
    );
  }
}

function parseAtlasUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebDoorError("invalid_config", "ATLAS_API_URL must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebDoorError("invalid_config", "ATLAS_API_URL must be an http(s) URL");
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Load and validate website Door configuration from environment variables.
 *
 * Required: `DOOR_KEY_PATH`, `SOUL_PUBLIC_KEY`. Everything else has a default; see the
 * package README for the full table.
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object in tests.
 */
export function loadWebDoorConfig(env: NodeJS.ProcessEnv = process.env): WebDoorConfig {
  const result = webDoorConfigSchema.safeParse({
    doorId: envValue(env, "DOOR_WEB_ID") ?? DEFAULT_DOOR_ID,
    doorKeyPath: requireEnv(env, "DOOR_KEY_PATH"),
    soulPublicKey: parseSoulPublicKey(requireEnv(env, "SOUL_PUBLIC_KEY")),
    doorHttpHost: envValue(env, "DOOR_HTTP_HOST") ?? DEFAULT_HOST,
    doorHttpPort: parsePositiveInt(env, "DOOR_HTTP_PORT", DEFAULT_DOOR_HTTP_PORT),
    publicHost: envValue(env, "DOOR_WEB_PUBLIC_HOST") ?? DEFAULT_HOST,
    publicPort: parsePositiveInt(env, "DOOR_WEB_PUBLIC_PORT", DEFAULT_PUBLIC_PORT),
    communityName: envValue(env, "DOOR_WEB_COMMUNITY_NAME") ?? DEFAULT_COMMUNITY_NAME,
    communityDescription:
      envValue(env, "DOOR_WEB_COMMUNITY_DESCRIPTION") ?? DEFAULT_COMMUNITY_DESCRIPTION,
    maxClients: parsePositiveInt(env, "DOOR_WEB_MAX_CLIENTS", DEFAULT_MAX_CLIENTS),
    globalPerMinute: parsePositiveInt(env, "DOOR_WEB_GLOBAL_PER_MIN", DEFAULT_GLOBAL_PER_MIN),
    dailyMax: parsePositiveInt(env, "DOOR_WEB_DAILY_MAX", DEFAULT_DAILY_MAX),
    trustProxy: envValue(env, "DOOR_WEB_TRUST_PROXY") === "1",
    ...(envValue(env, "ATLAS_API_URL") === undefined
      ? {}
      : { atlasApiUrl: parseAtlasUrl(envValue(env, "ATLAS_API_URL")) })
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new WebDoorError("invalid_config", `Invalid web Door configuration: ${detail}`);
  }
  return result.data;
}
