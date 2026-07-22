import { decodePublicKey } from "@npc/osp-core";
import { z } from "zod";

import { loadBrainConfig, type BrainConfig } from "./brain/config.js";
import { BrainError } from "./brain/errors.js";
import { DaemonError } from "./daemon-errors.js";

const DEFAULT_READY_FILE = "/tmp/npc-runtime.ready";

const daemonConfigSchema = z.object({
  soulKeyPath: z.string().min(1),
  soulchainDir: z.string().min(1),
  doorHttpHost: z.string().min(1),
  doorHttpPort: z.number().int().positive(),
  doorId: z.string().min(1),
  doorPublicKeys: z.array(z.instanceof(Uint8Array)).min(1),
  brain: z.custom<BrainConfig>(),
  readyFilePath: z.string().min(1)
});

/** Validated residency daemon configuration loaded from environment variables. */
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new DaemonError(`${name} is required but not set`, "invalid_config", name);
  }
  return value;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DaemonError(
      `${name} must be a positive integer (got ${value})`,
      "invalid_config",
      name
    );
  }
  return parsed;
}

function parseDoorPublicKeys(value: string): Uint8Array[] {
  const keys: Uint8Array[] = [];
  for (const segment of value.split(",")) {
    const trimmed = segment.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      keys.push(decodePublicKey(trimmed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonError(
        `ATLAS_DOOR_PUBKEYS contains invalid base64url public key: ${message}`,
        "invalid_config",
        "ATLAS_DOOR_PUBKEYS"
      );
    }
  }

  if (keys.length === 0) {
    throw new DaemonError(
      "ATLAS_DOOR_PUBKEYS must contain at least one valid base64url Ed25519 public key",
      "invalid_config",
      "ATLAS_DOOR_PUBKEYS"
    );
  }

  return keys;
}

/**
 * Load and validate residency daemon configuration from environment variables.
 *
 * Required: `SOUL_KEY_PATH`, `SOULCHAIN_DIR`, `DOOR_HTTP_HOST`, `DOOR_HTTP_PORT`,
 * `CURRENT_DOOR_ID`, `ATLAS_DOOR_PUBKEYS`, and Brain vars via {@link loadBrainConfig}.
 * Optional: `NPC_RUNTIME_READY_FILE` (defaults to `/tmp/npc-runtime.ready`).
 */
export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const soulKeyPath = requireEnv(env, "SOUL_KEY_PATH");
  const soulchainDir = requireEnv(env, "SOULCHAIN_DIR");
  const doorHttpHost = requireEnv(env, "DOOR_HTTP_HOST");
  const doorHttpPort = parsePositiveInt(requireEnv(env, "DOOR_HTTP_PORT"), "DOOR_HTTP_PORT");
  const doorId = requireEnv(env, "CURRENT_DOOR_ID");
  const doorPublicKeysRaw = requireEnv(env, "ATLAS_DOOR_PUBKEYS");
  const doorPublicKeys = parseDoorPublicKeys(doorPublicKeysRaw);

  let brain: BrainConfig;
  try {
    brain = loadBrainConfig(env);
  } catch (error) {
    if (error instanceof BrainError) {
      const envVar = error.message.includes("ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY" : undefined;
      throw new DaemonError(error.message, "invalid_config", envVar);
    }
    throw error;
  }

  const readyFilePath =
    env.NPC_RUNTIME_READY_FILE === undefined || env.NPC_RUNTIME_READY_FILE === ""
      ? DEFAULT_READY_FILE
      : env.NPC_RUNTIME_READY_FILE;

  const result = daemonConfigSchema.safeParse({
    soulKeyPath,
    soulchainDir,
    doorHttpHost,
    doorHttpPort,
    doorId,
    doorPublicKeys,
    brain,
    readyFilePath
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new DaemonError(`Invalid daemon configuration: ${detail}`, "invalid_config");
  }

  return result.data;
}
