import { z } from "zod";

import { QuarantineError } from "./errors.js";

const DEFAULT_QUARANTINE_WINDOW_MS = 86_400_000;

const quarantineConfigSchema = z.object({
  quarantineWindowMs: z.number().int().positive()
});

/** Validated quarantine configuration loaded from environment variables. */
export type QuarantineConfig = z.infer<typeof quarantineConfigSchema>;

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new QuarantineError(
      `${name} must be a positive integer (got ${value})`,
      "invalid_config"
    );
  }

  return parsed;
}

/**
 * Load and validate quarantine configuration from environment variables.
 *
 * Env var: `NPC_QUARANTINE_WINDOW_MS` (default 86400000 — 24 hours).
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object
 *   in tests so `process.env` is never mutated.
 */
export function loadQuarantineConfig(env: NodeJS.ProcessEnv = process.env): QuarantineConfig {
  const quarantineWindowMs = parsePositiveInt(
    env.NPC_QUARANTINE_WINDOW_MS,
    DEFAULT_QUARANTINE_WINDOW_MS,
    "NPC_QUARANTINE_WINDOW_MS"
  );

  const result = quarantineConfigSchema.safeParse({ quarantineWindowMs });
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new QuarantineError(`Invalid quarantine configuration: ${detail}`, "invalid_config");
  }

  return result.data;
}
