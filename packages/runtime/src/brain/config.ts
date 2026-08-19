import { readFileSync } from "node:fs";

import { z } from "zod";

import { BrainError } from "./errors.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export type BrainProvider = "anthropic" | "openai-compat" | "fake";

const anthropicConfigSchema = z.object({
  provider: z.literal("anthropic"),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive()
});

const openaiCompatConfigSchema = z.object({
  provider: z.literal("openai-compat"),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  baseUrl: z.string().min(1),
  providerAllowlist: z.array(z.string().min(1)).optional()
});

const fakeConfigSchema = z.object({
  provider: z.literal("fake"),
  model: z.string().min(1),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive()
});

const brainConfigSchema = z.discriminatedUnion("provider", [
  anthropicConfigSchema,
  openaiCompatConfigSchema,
  fakeConfigSchema
]);

/** Validated Anthropic Brain configuration. */
export type AnthropicBrainConfig = z.infer<typeof anthropicConfigSchema>;
/** Validated OpenAI-compatible Brain configuration. */
export type OpenAICompatBrainConfig = z.infer<typeof openaiCompatConfigSchema>;
/** Validated FakeBrain configuration (`NPC_BRAIN_PROVIDER=fake`; tests construct FakeBrain directly). */
export type FakeBrainConfig = z.infer<typeof fakeConfigSchema>;
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
    throw new BrainError(`failed to read ${fileVarName} at ${path}: ${detail}`, "invalid_config", {
      envVar: fileVarName
    });
  }

  const trimmed = contents.trim();
  if (trimmed === "") {
    throw new BrainError(`${fileVarName} at ${path} is empty`, "invalid_config", {
      envVar: fileVarName
    });
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
    throw new BrainError(`set only one of ${name} or ${fileName}`, "invalid_config", {
      envVar: name
    });
  }
  if (!hasDirect && !hasFile) {
    throw new BrainError(`${name} is required but not set`, "invalid_config", { envVar: name });
  }

  if (hasFile && filePath !== undefined) {
    return readSecretFromFile(filePath, fileName);
  }

  if (direct !== undefined) {
    return direct;
  }

  throw new BrainError(`${name} is required but not set`, "invalid_config", { envVar: name });
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BrainError(`${name} must be a positive integer (got ${value})`, "invalid_config", {
      envVar: name
    });
  }

  return parsed;
}

function parseProvider(raw: string | undefined): BrainProvider {
  if (raw === undefined || raw === "") {
    return "anthropic";
  }
  if (raw === "anthropic" || raw === "openai-compat" || raw === "fake") {
    return raw;
  }
  throw new BrainError(
    `NPC_BRAIN_PROVIDER must be anthropic, openai-compat, or fake (got ${raw})`,
    "invalid_config",
    { envVar: "NPC_BRAIN_PROVIDER" }
  );
}

/**
 * True when `baseUrl` is an OpenRouter API origin (`openrouter.ai` or a subdomain).
 */
export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
}

function parseHttpsUrl(raw: string | undefined, name: string): string {
  if (raw === undefined || raw === "") {
    throw new BrainError(`${name} is required but not set`, "invalid_config", { envVar: name });
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrainError(`${name} must be a valid URL`, "invalid_config", { envVar: name });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrainError(`${name} must be http or https`, "invalid_config", { envVar: name });
  }

  return raw.replace(/\/+$/, "");
}

const ALLOWLIST_SLUG = /^[a-z0-9][a-z0-9_./-]*$/;

function parseAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  const slugs: string[] = [];
  for (const token of raw.split(",")) {
    const slug = token.trim();
    if (slug === "") {
      continue;
    }
    if (!ALLOWLIST_SLUG.test(slug)) {
      throw new BrainError(
        `NPC_BRAIN_PROVIDER_ALLOWLIST contains an invalid provider slug`,
        "invalid_config",
        { envVar: "NPC_BRAIN_PROVIDER_ALLOWLIST" }
      );
    }
    slugs.push(slug);
  }
  return slugs;
}

function parseRequiredModel(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new BrainError("NPC_BRAIN_MODEL is required but not set", "invalid_config", {
      envVar: "NPC_BRAIN_MODEL"
    });
  }
  return raw;
}

/**
 * Load and validate Brain configuration from environment variables.
 *
 * `NPC_BRAIN_PROVIDER` selects `anthropic` (default), `openai-compat`, or `fake`.
 * Anthropic: `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FILE` (exactly one).
 * OpenAI-compat: `NPC_BRAIN_API_KEY` or `NPC_BRAIN_API_KEY_FILE`, `NPC_BRAIN_BASE_URL`,
 * `NPC_BRAIN_MODEL`; OpenRouter hosts also require non-empty `NPC_BRAIN_PROVIDER_ALLOWLIST`.
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object
 *   in tests so `process.env` is never mutated.
 */
export function loadBrainConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const provider = parseProvider(env.NPC_BRAIN_PROVIDER);
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

  let parsed: ReturnType<typeof brainConfigSchema.safeParse>;

  if (provider === "fake") {
    parsed = brainConfigSchema.safeParse({
      provider: "fake",
      model:
        env.NPC_BRAIN_MODEL === undefined || env.NPC_BRAIN_MODEL === ""
          ? "fake"
          : env.NPC_BRAIN_MODEL,
      maxTokens,
      timeoutMs
    });
  } else if (provider === "anthropic") {
    const apiKey = resolveSecretFromEnv(env, "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_FILE");
    const model =
      env.NPC_BRAIN_MODEL === undefined || env.NPC_BRAIN_MODEL === ""
        ? DEFAULT_ANTHROPIC_MODEL
        : env.NPC_BRAIN_MODEL;
    parsed = brainConfigSchema.safeParse({
      provider: "anthropic",
      apiKey,
      model,
      maxTokens,
      timeoutMs
    });
  } else {
    const apiKey = resolveSecretFromEnv(env, "NPC_BRAIN_API_KEY", "NPC_BRAIN_API_KEY_FILE");
    const baseUrl = parseHttpsUrl(env.NPC_BRAIN_BASE_URL, "NPC_BRAIN_BASE_URL");
    const model = parseRequiredModel(env.NPC_BRAIN_MODEL);
    const allowlist = parseAllowlist(env.NPC_BRAIN_PROVIDER_ALLOWLIST);
    if (isOpenRouterBaseUrl(baseUrl) && allowlist.length === 0) {
      throw new BrainError(
        "NPC_BRAIN_PROVIDER_ALLOWLIST is required and must be non-empty when NPC_BRAIN_BASE_URL is OpenRouter",
        "invalid_config",
        { envVar: "NPC_BRAIN_PROVIDER_ALLOWLIST" }
      );
    }

    const openaiCompat: {
      provider: "openai-compat";
      apiKey: string;
      model: string;
      maxTokens: number;
      timeoutMs: number;
      baseUrl: string;
      providerAllowlist?: string[];
    } = {
      provider: "openai-compat",
      apiKey,
      model,
      maxTokens,
      timeoutMs,
      baseUrl
    };
    if (isOpenRouterBaseUrl(baseUrl)) {
      openaiCompat.providerAllowlist = allowlist;
    }
    parsed = brainConfigSchema.safeParse(openaiCompat);
  }

  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BrainError(`Invalid Brain configuration: ${detail}`, "invalid_config");
  }

  return parsed.data;
}
