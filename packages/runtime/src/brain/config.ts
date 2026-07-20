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
 * Env vars: `ANTHROPIC_API_KEY` (required), `NPC_BRAIN_MODEL`,
 * `NPC_BRAIN_MAX_TOKENS`, `NPC_BRAIN_TIMEOUT_MS`.
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object
 *   in tests so `process.env` is never mutated.
 */
export function loadBrainConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new BrainError("ANTHROPIC_API_KEY is required but not set");
  }

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
