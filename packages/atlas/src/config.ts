import { EncodingError, parseDoorPublicKeyMap } from "@npc/osp-core";
import { z } from "zod";

import { AtlasError } from "./errors.js";

const DEFAULT_PORT = 8787;

const atlasConfigSchema = z.object({
  chainDir: z.string().min(1),
  port: z.number().int().positive(),
  doorPublicKeys: z.record(z.string(), z.instanceof(Uint8Array)).optional()
});

/** Validated Atlas API configuration loaded from environment variables. */
export type AtlasConfig = z.infer<typeof atlasConfigSchema>;

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AtlasError(
      "invalid_config",
      `${name} must be a positive integer (got ${value})`,
      500
    );
  }

  return parsed;
}

function parseDoorPublicKeys(
  value: string | undefined
): Readonly<Record<string, Uint8Array>> | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  try {
    const map = parseDoorPublicKeyMap(value);
    return Object.keys(map).length > 0 ? map : undefined;
  } catch (error) {
    if (error instanceof EncodingError) {
      throw new AtlasError("invalid_config", `ATLAS_DOOR_PUBKEYS: ${error.message}`, 500);
    }
    throw error;
  }
}

/**
 * Load and validate Atlas configuration from environment variables.
 *
 * Env vars: `ATLAS_CHAIN_DIR` (required), `ATLAS_PORT` (default 8787),
 * `ATLAS_DOOR_PUBKEYS` (optional comma-separated `doorId=base64url` bindings).
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object in tests.
 */
export function loadAtlasConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig {
  const chainDir = env.ATLAS_CHAIN_DIR;
  if (chainDir === undefined || chainDir === "") {
    throw new AtlasError("invalid_config", "ATLAS_CHAIN_DIR is required but not set", 500);
  }

  const port = parsePositiveInt(env.ATLAS_PORT, DEFAULT_PORT, "ATLAS_PORT");
  const doorPublicKeys = parseDoorPublicKeys(env.ATLAS_DOOR_PUBKEYS);

  const result = atlasConfigSchema.safeParse({
    chainDir,
    port,
    doorPublicKeys
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new AtlasError("invalid_config", `Invalid Atlas configuration: ${detail}`, 500);
  }

  return result.data;
}
