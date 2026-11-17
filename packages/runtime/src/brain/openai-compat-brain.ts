import { z } from "zod";

import type { BrainConfig, OpenAICompatBrainConfig } from "./config.js";
import { BrainError, type BrainErrorReason } from "./errors.js";
import { splitMessages } from "./messages.js";
import type { Brain, BrainMessage, BrainResult, CompleteOptions } from "./types.js";
import { ZERO_BRAIN_USAGE } from "./types.js";

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 200;

/**
 * Max OpenAI-compatible chat-completion response body, in bytes.
 *
 * Default output is 1024 tokens. 4 MiB still fits a long reasoning trace or a
 * provider payload with extra JSON, and it is the limit read before `JSON.parse`.
 * Overflow throws {@link BrainError} (`provider`) whose `cause` is a plain
 * `Error` and carries no request headers or parameters.
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

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
  /** OpenAI-compat `max_tokens`. First-party OpenAI newer models may require `max_completion_tokens` instead. */
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
    const capAbort = new AbortController();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), capAbort.signal])
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

    let bodyText: string;
    try {
      bodyText = await readCappedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES, capAbort);
    } catch (error) {
      if (error instanceof BrainError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new BrainError("OpenAI-compatible API request timed out", "timeout", {
          cause: error
        });
      }
      throw new BrainError("OpenAI-compatible API request failed", "unavailable", {
        cause: error
      });
    }
    if (!response.ok) {
      const reason = reasonFromHttpStatus(response.status, bodyText);
      const snippet = errorBodySnippet(bodyText);
      throw new BrainError(
        `OpenAI-compatible API request failed (${String(response.status)})`,
        reason,
        {
          cause:
            snippet === ""
              ? { status: response.status }
              : { status: response.status, body: snippet }
        }
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

/** Truncate a provider error body for `BrainError.cause` — never include request headers or keys. */
function errorBodySnippet(bodyText: string): string {
  const collapsed = bodyText.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 200) {
    return collapsed;
  }
  return `${collapsed.slice(0, 200)}…`;
}

/**
 * Cap failure for a provider body. `cause` is a plain Error: no status, headers,
 * request parameters, or response bytes.
 */
function responseTooLarge(): BrainError {
  return new BrainError(
    `OpenAI-compatible API response exceeds ${String(MAX_PROVIDER_RESPONSE_BYTES)} bytes`,
    "provider",
    { cause: new Error("response body exceeds cap") }
  );
}

/**
 * Read a response body as UTF-8, refusing anything over `maxBytes`.
 *
 * A Content-Length above the cap fails before the body is read. Otherwise the
 * body is streamed and the download is aborted as soon as the running total
 * exceeds the cap. Exactly `maxBytes` is accepted.
 */
async function readCappedResponseText(
  response: Response,
  maxBytes: number,
  abort: AbortController
): Promise<string> {
  if (contentLengthExceeds(response, maxBytes)) {
    await abortCappedRead(response, undefined, abort);
    throw responseTooLarge();
  }

  const body = response.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const value = next.value;
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.length = 0;
        await abortCappedRead(response, reader, abort);
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BrainError) {
      throw error;
    }
    await abortCappedRead(response, reader, abort);
    throw error;
  }

  return new TextDecoder().decode(concatBytes(chunks));
}

/** True when Content-Length is a byte count strictly above `maxBytes`. */
function contentLengthExceeds(response: Response, maxBytes: number): boolean {
  const header = response.headers.get("content-length");
  if (header === null) {
    return false;
  }
  const trimmed = header.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return false;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return true;
  }
  return value > maxBytes;
}

/**
 * Abort the fetch and cancel the body. Swallows cancel failures so the size
 * error (whose cause has no request data) is what callers see.
 */
async function abortCappedRead(
  response: Response,
  reader: { cancel: () => Promise<void> } | undefined,
  abort: AbortController
): Promise<void> {
  abort.abort();
  try {
    if (reader !== undefined) {
      await reader.cancel();
      return;
    }
    if (response.body !== null) {
      await response.body.cancel();
    }
  } catch {
    // The peer may already have dropped the socket.
  }
}

/** Copy streamed chunks into one buffer. `chunks` together are at most the cap. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
