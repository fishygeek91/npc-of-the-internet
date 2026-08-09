import { readFileSync } from "node:fs";

import { z } from "zod";

import { BrainError } from "./errors.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

const brainConfigSchema = z.object({
  apiKey: z.string().min(1, "ANTHROPIC_API_KEY must be a non-empty string"),
  model: z.string().min(1),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive()
});

/** Validated Brain configuration loaded from environment variables. */
export type BrainConfig = z.infer<typeof brainConfigSchema>;

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
    throw new BrainError(`failed to read ${fileVarName} at ${path}: ${detail}`);
  }

  const trimmed = contents.trim();
  if (trimmed === "") {
    throw new BrainError(`${fileVarName} at ${path} is empty`);
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
    throw new BrainError(`set only one of ${name} or ${fileName}`);
  }
  if (!hasDirect && !hasFile) {
    throw new BrainError(`${name} is required but not set`);
  }

  if (hasFile && filePath !== undefined) {
    return readSecretFromFile(filePath, fileName);
  }

  if (direct !== undefined) {
    return direct;
  }

  throw new BrainError(`${name} is required but not set`);
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BrainError(`${name} must be a positive integer (got ${value})`);
  }

  return parsed;
}

/**
 * Load and validate Brain configuration from environment variables.
 *
 * Env vars: `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FILE` (exactly one required),
 * `NPC_BRAIN_MODEL`, `NPC_BRAIN_MAX_TOKENS`, `NPC_BRAIN_TIMEOUT_MS`.
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object
 *   in tests so `process.env` is never mutated.
 */
export function loadBrainConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const apiKey = resolveSecretFromEnv(env, "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_FILE");

  const model =
    env.NPC_BRAIN_MODEL === undefined || env.NPC_BRAIN_MODEL === ""
      ? DEFAULT_MODEL
      : env.NPC_BRAIN_MODEL;

  const maxTokens = parsePositiveInt(
    env.NPC_BRAIN_MAX_TOKENS,
    DEFAULT_MAX_TOKENS,
    "NPC_BRAIN_MAX_TOKENS"
  );
  const timeoutMs = parsePositiveInt(
    env.NPC_BRAIN_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "NPC_BRAIN_TIMEOUT_MS"
  );

  const result = brainConfigSchema.safeParse({
    apiKey,
    model,
    maxTokens,
    timeoutMs
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new BrainError(`Invalid Brain configuration: ${detail}`);
  }

  return result.data;
}
