import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { WITNESS_SYSTEM_PROMPT, buildWitnessUserPrompt } from "./prompts/witness.js";
import type { ResidencyLine } from "./residency-record.js";
import { WitnessReasonSchema, type WitnessReason } from "./schemas.js";

/** What a Door witnesses: a memory shard, or the residency journal written from them. */
export type MemoryKind = "shard" | "journal";

/** Input to a {@link WitnessMemory} policy. */
export type WitnessInput = {
  doorId: string;
  epoch: number;
  kind: MemoryKind;
  /** The memory prose the Wanderer wants to keep (untrusted). */
  text: string;
  /** The Door's own record of the residency, oldest first (untrusted). */
  transcript: readonly ResidencyLine[];
};

/** A witness decision. */
export type WitnessVerdict = { witnessed: true } | { witnessed: false; reason: WitnessReason };

/**
 * Door memory witness: resolve a verdict, or throw when no verdict can be reached right
 * now (the Door answers `witness_unavailable` and the Wanderer retries later — an outage
 * is never a decline).
 */
export type WitnessMemory = (input: WitnessInput) => Promise<WitnessVerdict>;

/** One chat completion: system + user prompt in, assistant text out. Throws on failure. */
export type CompleteFn = (args: { system: string; user: string }) => Promise<string>;

/** Options for {@link createAiWitness}. */
export type AiWitnessOptions = {
  complete: CompleteFn;
  /** Attempts per memory when the call fails or the verdict is unparseable (default 2). */
  attempts?: number;
  /** Random delimiter source (tests). */
  randomTag?: () => string;
};

const DEFAULT_ATTEMPTS = 2;

/**
 * Parse a witness reply: the JSON object that **ends** the reply (reasoning models may
 * think out loud first; a closing code fence may follow). Returns null when the reply
 * does not end in a verdict object, so a truncated or malformed answer never falls back
 * to a verdict quoted earlier in the reasoning, and a nested `verdict` never overrides
 * the outer object's.
 */
export function parseWitnessReply(reply: string): WitnessVerdict | null {
  const end = reply.lastIndexOf("}");
  if (end < 0 || !/^[\s`]*$/u.test(reply.slice(end + 1))) {
    return null;
  }
  // The outermost object ending at `end`: the earliest `{` whose span parses.
  for (
    let start = reply.indexOf("{");
    start >= 0 && start < end;
    start = reply.indexOf("{", start + 1)
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    } catch {
      continue;
    }
    return verdictFrom(parsed);
  }
  return null;
}

function verdictFrom(parsed: unknown): WitnessVerdict | null {
  if (typeof parsed !== "object" || parsed === null || !("verdict" in parsed)) {
    return null;
  }
  const verdict = (parsed as { verdict: unknown }).verdict;
  if (verdict === "witness") {
    return { witnessed: true };
  }
  if (verdict === "decline") {
    const reason = WitnessReasonSchema.safeParse((parsed as { reason?: unknown }).reason);
    return { witnessed: false, reason: reason.success ? reason.data : "other" };
  }
  return null;
}

/**
 * Reference AI witness: one independent model call per memory with a fixed rubric
 * ({@link WITNESS_SYSTEM_PROMPT}). Fails closed in the safe direction: an unparseable
 * verdict or failed call is retried, then thrown (`witness_unavailable`), never
 * turned into a witness.
 */
export function createAiWitness(options: AiWitnessOptions): WitnessMemory {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const randomTag = options.randomTag ?? ((): string => randomBytes(6).toString("hex"));
  return async (input) => {
    let lastError: unknown = new Error("witness produced no verdict");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const reply = await options.complete({
          system: WITNESS_SYSTEM_PROMPT,
          user: buildWitnessUserPrompt(input, randomTag())
        });
        const verdict = parseWitnessReply(reply);
        if (verdict !== null) {
          return verdict;
        }
        lastError = new Error("witness reply had no parseable verdict");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

/** OpenAI-compatible chat-completions settings for {@link openAiCompatComplete}. */
export type OpenAiCompatSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** OpenRouter `provider.only` allowlist, when set. */
  providerAllowlist?: readonly string[];
  timeoutMs?: number;
  /** Completion budget; reasoning models need room to think (default 2048). */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

/** {@link CompleteFn} over any OpenAI chat-completions-compatible HTTP API. */
export function openAiCompatComplete(settings: OpenAiCompatSettings): CompleteFn {
  const fetchImpl = settings.fetchImpl ?? fetch;
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async ({ system, user }) => {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: settings.maxTokens ?? 2048,
      temperature: 0
    };
    if (settings.providerAllowlist !== undefined && settings.providerAllowlist.length > 0) {
      body.provider = { only: settings.providerAllowlist };
    }
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeoutMs ?? 60_000)
    });
    if (!response.ok) {
      // Never echo the response body: providers sometimes reflect request headers.
      throw new Error(`witness model HTTP ${String(response.status)}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    };
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
      // A cut-off reply may end inside the reasoning: never parse it for a verdict.
      throw new Error("witness model reply was truncated (max_tokens)");
    }
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new Error("witness model returned no message content");
    }
    return content;
  };
}

/** Error naming the env var at fault (never a secret value). */
export class WitnessConfigError extends Error {
  readonly envVar: string;

  constructor(message: string, envVar: string) {
    super(message);
    this.name = "WitnessConfigError";
    this.envVar = envVar;
  }
}

/** Resolved witness settings, or `null` when witnessing is off. */
export type WitnessConfig = OpenAiCompatSettings | null;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readKeyFile(path: string, envVar: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch {
    throw new WitnessConfigError(`${envVar}: cannot read ${path}`, envVar);
  }
  if (contents === "") {
    throw new WitnessConfigError(`${envVar}: ${path} is empty`, envVar);
  }
  return contents;
}

/**
 * Witness settings from the environment. When `NPC_BRAIN_PROVIDER=openai-compat`, each
 * `DOOR_WITNESS_*` value falls back to the matching `NPC_BRAIN_*` value, so a Door that runs
 * beside the Wanderer's runtime needs no extra setup:
 *
 * | Setting | Env (fallback) |
 * |---|---|
 * | base URL | `DOOR_WITNESS_BASE_URL` (`NPC_BRAIN_BASE_URL`) |
 * | API key | `DOOR_WITNESS_API_KEY` / `DOOR_WITNESS_API_KEY_FILE` (`NPC_BRAIN_API_KEY` / `NPC_BRAIN_API_KEY_FILE`) |
 * | model | `DOOR_WITNESS_MODEL` (`NPC_BRAIN_MODEL`) |
 * | OpenRouter allowlist | `DOOR_WITNESS_PROVIDER_ALLOWLIST` (`NPC_BRAIN_PROVIDER_ALLOWLIST`), comma-separated |
 * | timeout | `DOOR_WITNESS_TIMEOUT_MS` (default 60000) |
 *
 * `DOOR_WITNESS=off` turns witnessing off (the Wanderer forms no memories at this Door).
 * The Brain's API key is only borrowed when the Brain's base URL is used too.
 * Returns `null` when off or when no base URL / key / model is configured at all; throws
 * {@link WitnessConfigError} when configuration is partial or invalid.
 */
export function loadWitnessConfig(env: NodeJS.ProcessEnv = process.env): WitnessConfig {
  const mode = envValue(env, "DOOR_WITNESS")?.toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") {
    return null;
  }
  // The Brain's settings are only a usable fallback when the Brain speaks the same
  // (OpenAI-compatible) protocol as the witness client.
  const brainFallback = envValue(env, "NPC_BRAIN_PROVIDER") === "openai-compat";
  const pick = (own: string, fallback: string): { value?: string; name: string } => {
    const value = envValue(env, own);
    if (value !== undefined) {
      return { value, name: own };
    }
    const fallbackValue = brainFallback ? envValue(env, fallback) : undefined;
    return fallbackValue !== undefined ? { value: fallbackValue, name: fallback } : { name: own };
  };
  const baseUrl = pick("DOOR_WITNESS_BASE_URL", "NPC_BRAIN_BASE_URL");
  const model = pick("DOOR_WITNESS_MODEL", "NPC_BRAIN_MODEL");
  // First match wins: the Door's own key, then the Brain's (inline before file). The
  // Brain's key is only borrowed when the Brain's base URL is used too — a Brain key must
  // never be sent to a different host the operator configured for the witness.
  const borrowBrainKey = baseUrl.name === "NPC_BRAIN_BASE_URL";
  const keySources = [
    ["DOOR_WITNESS_API_KEY", false],
    ["DOOR_WITNESS_API_KEY_FILE", true],
    ...(borrowBrainKey
      ? ([
          ["NPC_BRAIN_API_KEY", false],
          ["NPC_BRAIN_API_KEY_FILE", true]
        ] as const)
      : [])
  ] as const;
  let apiKey: string | undefined;
  for (const [name, isFile] of keySources) {
    const value = envValue(env, name);
    if (value !== undefined) {
      apiKey = isFile ? readKeyFile(value, name) : value;
      break;
    }
  }

  if (baseUrl.value === undefined && apiKey === undefined && model.value === undefined) {
    return null;
  }
  if (baseUrl.value === undefined) {
    throw new WitnessConfigError(
      "DOOR_WITNESS_BASE_URL (or NPC_BRAIN_BASE_URL) is required for the memory witness",
      "DOOR_WITNESS_BASE_URL"
    );
  }
  if (apiKey === undefined) {
    throw new WitnessConfigError(
      "DOOR_WITNESS_API_KEY / _FILE (or NPC_BRAIN_API_KEY / _FILE) is required for the memory witness",
      "DOOR_WITNESS_API_KEY"
    );
  }
  if (model.value === undefined) {
    throw new WitnessConfigError(
      "DOOR_WITNESS_MODEL (or NPC_BRAIN_MODEL) is required for the memory witness",
      "DOOR_WITNESS_MODEL"
    );
  }
  const timeoutRaw = envValue(env, "DOOR_WITNESS_TIMEOUT_MS");
  let timeoutMs = 60_000;
  if (timeoutRaw !== undefined) {
    timeoutMs = Number.parseInt(timeoutRaw, 10);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || String(timeoutMs) !== timeoutRaw) {
      throw new WitnessConfigError(
        "DOOR_WITNESS_TIMEOUT_MS must be an integer ≥ 1000",
        "DOOR_WITNESS_TIMEOUT_MS"
      );
    }
  }
  const allowlistRaw = pick("DOOR_WITNESS_PROVIDER_ALLOWLIST", "NPC_BRAIN_PROVIDER_ALLOWLIST");
  const providerAllowlist = allowlistRaw.value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return {
    baseUrl: baseUrl.value,
    apiKey,
    model: model.value,
    timeoutMs,
    ...(providerAllowlist !== undefined && providerAllowlist.length > 0
      ? { providerAllowlist }
      : {})
  };
}
