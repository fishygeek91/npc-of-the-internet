import { readFileSync } from "node:fs";
import { z } from "zod";

import { DaemonError } from "../daemon-errors.js";

const DEFAULT_PUBLISHED_CAR_PATH = "/data/published/soulchain-latest.car";
const DEFAULT_MANIFEST_CID_PATH = "/data/published/manifest-cid.txt";
const DEFAULT_DRAIN_INTERVAL_MS = 15_000;

const TARGET_NAME_PATTERN = /^[a-z0-9_-]+$/;

const replicationTargetSchema = z.object({
  name: z.string().regex(TARGET_NAME_PATTERN, "target name must match [a-z0-9_-]+"),
  kind: z.literal("car-upload"),
  endpoint: z.string().url(),
  tokenEnv: z.string().min(1)
});

const replicationConfigSchema = z.object({
  enabled: z.boolean(),
  ipfsDir: z.string(),
  publishedCarPath: z.string().min(1),
  manifestCidPath: z.string().min(1),
  targets: z.array(replicationTargetSchema),
  drainIntervalMs: z.number().int().positive()
});

/** One outbound replication target (CAR upload over HTTPS). */
export type ReplicationTarget = z.infer<typeof replicationTargetSchema>;

/** Runtime replication drain configuration from environment variables. */
export type ReplicationConfig = z.infer<typeof replicationConfigSchema>;

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function isReplicationEnabledFlag(value: string | undefined): boolean {
  if (value === undefined || value === "") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/**
 * Read a secret from a file path named by a companion `*_FILE` env var.
 * Error messages name the env var and path only — never secret values.
 */
function readSecretFromFile(path: string, fileVarName: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new DaemonError(`failed to read ${fileVarName} at ${path}: ${detail}`, "invalid_config");
  }

  const trimmed = contents.trim();
  if (trimmed === "") {
    throw new DaemonError(`${fileVarName} at ${path} is empty`, "invalid_config", fileVarName);
  }

  return trimmed;
}

/**
 * Resolve a bearer token from `env[tokenEnv]` or `env[tokenEnv + "_FILE"]`.
 * Exactly one must be set when validation is required.
 */
export function resolveTokenFromEnv(env: NodeJS.ProcessEnv, tokenEnv: string): string {
  const fileVarName = `${tokenEnv}_FILE`;
  const direct = env[tokenEnv];
  const filePath = env[fileVarName];
  const hasDirect = isEnvSet(direct);
  const hasFile = isEnvSet(filePath);

  if (hasDirect && hasFile) {
    throw new DaemonError(
      `set only one of ${tokenEnv} or ${fileVarName}`,
      "invalid_config",
      tokenEnv
    );
  }
  if (!hasDirect && !hasFile) {
    throw new DaemonError(`${tokenEnv} is required but not set`, "invalid_config", tokenEnv);
  }

  if (hasFile && filePath !== undefined) {
    return readSecretFromFile(filePath, fileVarName);
  }

  if (direct !== undefined) {
    return direct;
  }

  throw new DaemonError(`${tokenEnv} is required but not set`, "invalid_config", tokenEnv);
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }

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

function parseTargetsJson(raw: string | undefined): ReplicationTarget[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DaemonError(
      "NPC_REPLICATION_TARGETS must be a JSON array",
      "invalid_config",
      "NPC_REPLICATION_TARGETS"
    );
  }

  if (!Array.isArray(parsed)) {
    throw new DaemonError(
      "NPC_REPLICATION_TARGETS must be a JSON array",
      "invalid_config",
      "NPC_REPLICATION_TARGETS"
    );
  }

  const targets: ReplicationTarget[] = [];
  for (const entry of parsed) {
    const result = replicationTargetSchema.safeParse(entry);
    if (!result.success) {
      const detail = result.error.issues.map((issue) => issue.message).join("; ");
      throw new DaemonError(
        `invalid NPC_REPLICATION_TARGETS entry: ${detail}`,
        "invalid_config",
        "NPC_REPLICATION_TARGETS"
      );
    }
    targets.push(result.data);
  }

  return targets;
}

/**
 * Load replication configuration from environment variables.
 *
 * When `NPC_REPLICATION_ENABLED` is not `1` or `true`, returns disabled defaults
 * (empty targets) even if targets are configured.
 *
 * Env vars: `NPC_REPLICATION_ENABLED`, `NPC_SOULCHAIN_IPFS_DIR`, `NPC_PUBLISHED_CAR_PATH`,
 * `NPC_MANIFEST_CID_PATH`, `NPC_REPLICATION_TARGETS` (JSON array), `NPC_REPLICATION_DRAIN_INTERVAL_MS`.
 */
export function loadReplicationConfig(env: NodeJS.ProcessEnv = process.env): ReplicationConfig {
  const enabled = isReplicationEnabledFlag(env.NPC_REPLICATION_ENABLED);
  const ipfsDirRaw = env.NPC_SOULCHAIN_IPFS_DIR;
  const ipfsDir = ipfsDirRaw === undefined || ipfsDirRaw.trim() === "" ? "" : ipfsDirRaw.trim();

  const publishedCarPath =
    env.NPC_PUBLISHED_CAR_PATH === undefined || env.NPC_PUBLISHED_CAR_PATH === ""
      ? DEFAULT_PUBLISHED_CAR_PATH
      : env.NPC_PUBLISHED_CAR_PATH;

  const manifestCidPath =
    env.NPC_MANIFEST_CID_PATH === undefined || env.NPC_MANIFEST_CID_PATH === ""
      ? DEFAULT_MANIFEST_CID_PATH
      : env.NPC_MANIFEST_CID_PATH;

  const drainIntervalMs = parsePositiveInt(
    env.NPC_REPLICATION_DRAIN_INTERVAL_MS,
    DEFAULT_DRAIN_INTERVAL_MS,
    "NPC_REPLICATION_DRAIN_INTERVAL_MS"
  );

  if (!enabled) {
    const disabledResult = replicationConfigSchema.safeParse({
      enabled: false,
      ipfsDir,
      publishedCarPath,
      manifestCidPath,
      targets: [],
      drainIntervalMs
    });
    if (!disabledResult.success) {
      const detail = disabledResult.error.issues.map((issue) => issue.message).join("; ");
      throw new DaemonError(`Invalid replication configuration: ${detail}`, "invalid_config");
    }
    return disabledResult.data;
  }

  if (ipfsDir === "") {
    throw new DaemonError(
      "NPC_SOULCHAIN_IPFS_DIR is required when NPC_REPLICATION_ENABLED is set",
      "invalid_config",
      "NPC_SOULCHAIN_IPFS_DIR"
    );
  }

  const targets = parseTargetsJson(env.NPC_REPLICATION_TARGETS);

  if (targets.length > 0) {
    for (const target of targets) {
      resolveTokenFromEnv(env, target.tokenEnv);
    }
  }

  const result = replicationConfigSchema.safeParse({
    enabled: true,
    ipfsDir,
    publishedCarPath,
    manifestCidPath,
    targets,
    drainIntervalMs
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new DaemonError(`Invalid replication configuration: ${detail}`, "invalid_config");
  }

  return result.data;
}
