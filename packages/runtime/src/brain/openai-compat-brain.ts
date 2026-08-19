import { z } from "zod";

import type { BrainConfig, OpenAICompatBrainConfig } from "./config.js";
import { BrainError, type BrainErrorReason } from "./errors.js";
import { splitMessages } from "./messages.js";
import type { Brain, BrainMessage, BrainResult, CompleteOptions } from "./types.js";
import { ZERO_BRAIN_USAGE } from "./types.js";

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 200;

const chatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable()
        })
      })
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number()
    })
    .optional()
});

type ChatCompletionBody = {
  model: string;
  messages: BrainMessage[];
  max_tokens: number;
  temperature?: number;
  stop?: string[];
  provider?: { only: readonly string[] };
};

/** Injectable sleep used so retry tests do not wait on real timers. */
export type SleepFn = (ms: number) => Promise<void>;

/** Injectable RNG in `[0, 1)` for jittered backoff. */
export type RandomFn = () => number;

/** Options for constructing an {@link OpenAICompatBrain}. */
export type OpenAICompatBrainOptions = {
  config: BrainConfig;
  fetchImpl?: typeof fetch;
  sleep?: SleepFn;
  random?: RandomFn;
};

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function isCreditExhaustedBody(bodyText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const errorField = "error" in parsed ? parsed.error : parsed;
    if (typeof errorField !== "object" || errorField === null) {
      return false;
    }
    const code = "code" in errorField ? errorField.code : undefined;
    const type = "type" in errorField ? errorField.type : undefined;
    return code === "insufficient_quota" || type === "insufficient_quota";
  } catch {
    return false;
  }
}

function reasonFromHttpStatus(status: number, bodyText: string): BrainErrorReason {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 402) {
    return "credit_exhausted";
  }
  if (status === 429) {
    return isCreditExhaustedBody(bodyText) ? "credit_exhausted" : "rate_limited";
  }
  if (status >= 500) {
    return "unavailable";
  }
  return "invalid_request";
}

function shouldRetry(reason: BrainErrorReason, status: number | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  if (reason === "credit_exhausted") {
    return false;
  }
  if (reason === "rate_limited" && status === 429) {
    return true;
  }
  if (reason === "unavailable" && status >= 500) {
    return true;
  }
  return false;
}

/**
 * Brain backed by any OpenAI chat-completions-compatible HTTP API.
 *
 * Provider choice is config: `NPC_BRAIN_BASE_URL` + `NPC_BRAIN_MODEL`.
 * When the base URL is OpenRouter, every request includes `provider.only`
 * from `NPC_BRAIN_PROVIDER_ALLOWLIST`. Temperature is omitted unless
 * {@link CompleteOptions.temperature} is set (provider default applies;
 * OpenAI-compatible APIs typically default to 1.0).
 */
export class OpenAICompatBrain implements Brain {
  private readonly config: OpenAICompatBrainConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: SleepFn;
  private readonly random: RandomFn;

  constructor(options: OpenAICompatBrainOptions) {
    if (options.config.provider !== "openai-compat") {
      throw new BrainError(
        `OpenAICompatBrain requires provider openai-compat (got ${options.config.provider})`,
        "invalid_config",
        { envVar: "NPC_BRAIN_PROVIDER" }
      );
    }
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<BrainResult> {
    const { system, conversation } = splitMessages(messages);
    const payloadMessages: BrainMessage[] =
      system !== undefined ? [{ role: "system", content: system }, ...conversation] : conversation;

    const body: ChatCompletionBody = {
      model: this.config.model,
      messages: payloadMessages,
      max_tokens: opts?.maxTokens ?? this.config.maxTokens
    };
    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }
    if (opts?.stopSequences !== undefined) {
      body.stop = opts.stopSequences;
    }
    if (this.config.providerAllowlist !== undefined) {
      body.provider = { only: this.config.providerAllowlist };
    }

    let lastError: BrainError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        const jitter = 0.5 + this.random() * 0.5;
        const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1) * jitter;
        await this.sleep(delayMs);
      }

      try {
        return await this.once(body);
      } catch (error) {
        if (!(error instanceof BrainError)) {
          throw error;
        }
        lastError = error;
        const status = httpStatusFromCause(error.cause);
        if (attempt >= MAX_RETRIES || !shouldRetry(error.reason, status)) {
          throw error;
        }
      }
    }

    throw lastError ?? new BrainError("OpenAI-compatible API request failed", "provider");
  }

  private async once(body: ChatCompletionBody): Promise<BrainResult> {
    const url = chatCompletionsUrl(this.config.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new BrainError("OpenAI-compatible API request timed out", "timeout", {
          cause: error
        });
      }
      throw new BrainError("OpenAI-compatible API request failed", "unavailable", {
        cause: error
      });
    }

    const bodyText = await response.text();
    if (!response.ok) {
      const reason = reasonFromHttpStatus(response.status, bodyText);
      throw new BrainError(
        `OpenAI-compatible API request failed (${String(response.status)})`,
        reason,
        { cause: { status: response.status } }
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch (error) {
      throw new BrainError("OpenAI-compatible API returned non-JSON", "provider", {
        cause: error
      });
    }

    const parsed = chatCompletionResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new BrainError("OpenAI-compatible API returned an unexpected payload", "provider");
    }

    const content = parsed.data.choices[0]?.message.content;
    if (content === undefined || content === null) {
      throw new BrainError("OpenAI-compatible API returned no assistant text", "provider");
    }

    const usage =
      parsed.data.usage === undefined
        ? ZERO_BRAIN_USAGE
        : {
            promptTokens: parsed.data.usage.prompt_tokens,
            completionTokens: parsed.data.usage.completion_tokens
          };

    return { text: content, usage };
  }
}

function httpStatusFromCause(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) {
    return undefined;
  }
  const status = cause.status;
  return typeof status === "number" ? status : undefined;
}
