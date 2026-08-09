import { EncodingError, parseDoorPublicKeyMap } from "@npc/osp-core";
import { z } from "zod";

import { loadBrainConfig, type BrainConfig } from "./brain/config.js";
import { BrainError } from "./brain/errors.js";
import { DaemonError } from "./daemon-errors.js";
import { loadReplicationConfig, type ReplicationConfig } from "./replication/config.js";

const DEFAULT_READY_FILE = "/tmp/npc-runtime.ready";

const daemonConfigSchema = z.object({
  soulKeyPath: z.string().min(1),
  soulchainDir: z.string().min(1),
  soulchainIpfsDir: z.string().min(1).optional(),
  doorHttpHost: z.string().min(1),
  doorHttpPort: z.number().int().positive(),
  doorId: z.string().min(1),
  doorPublicKeys: z
    .record(z.string(), z.instanceof(Uint8Array))
    .refine((map) => Object.keys(map).length >= 1, {
      message: "doorPublicKeys must contain at least one entry"
    }),
  brain: z.custom<BrainConfig>(),
  readyFilePath: z.string().min(1),
  replication: z.custom<ReplicationConfig>()
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

function parseDoorPublicKeys(value: string): Readonly<Record<string, Uint8Array>> {
  try {
    const map = parseDoorPublicKeyMap(value);
    if (Object.keys(map).length === 0) {
      throw new DaemonError(
        "ATLAS_DOOR_PUBKEYS must contain at least one doorId=base64url binding",
        "invalid_config",
        "ATLAS_DOOR_PUBKEYS"
      );
    }
    return map;
  } catch (error) {
    if (error instanceof EncodingError) {
      throw new DaemonError(
        `ATLAS_DOOR_PUBKEYS: ${error.message}`,
        "invalid_config",
        "ATLAS_DOOR_PUBKEYS"
      );
    }
    throw error;
  }
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
      const envVar = error.message.includes("ANTHROPIC_API_KEY_FILE")
        ? "ANTHROPIC_API_KEY_FILE"
        : error.message.includes("ANTHROPIC_API_KEY")
          ? "ANTHROPIC_API_KEY"
          : undefined;
      throw new DaemonError(error.message, "invalid_config", envVar);
    }
    throw error;
  }

  const readyFilePath =
    env.NPC_RUNTIME_READY_FILE === undefined || env.NPC_RUNTIME_READY_FILE === ""
      ? DEFAULT_READY_FILE
      : env.NPC_RUNTIME_READY_FILE;

  const soulchainIpfsRaw = env.NPC_SOULCHAIN_IPFS_DIR;
  const soulchainIpfsDir =
    soulchainIpfsRaw === undefined || soulchainIpfsRaw.trim() === ""
      ? undefined
      : soulchainIpfsRaw.trim();

  const replication = loadReplicationConfig(env);

  if (replication.enabled && soulchainIpfsDir === undefined) {
    throw new DaemonError(
      "NPC_SOULCHAIN_IPFS_DIR is required when NPC_REPLICATION_ENABLED is set",
      "invalid_config",
      "NPC_SOULCHAIN_IPFS_DIR"
    );
  }

  const result = daemonConfigSchema.safeParse({
    soulKeyPath,
    soulchainDir,
    soulchainIpfsDir,
    doorHttpHost,
    doorHttpPort,
    doorId,
    doorPublicKeys,
    brain,
    readyFilePath,
    replication
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new DaemonError(`Invalid daemon configuration: ${detail}`, "invalid_config");
  }

  return result.data;
}
