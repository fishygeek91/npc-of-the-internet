import Anthropic from "@anthropic-ai/sdk";

import type { AnthropicBrainConfig, BrainConfig } from "./config.js";
import { BrainError } from "./errors.js";
import { splitMessages } from "./messages.js";
import type { Brain, BrainMessage, BrainResult, CompleteOptions } from "./types.js";
import { ZERO_BRAIN_USAGE } from "./types.js";

/** Minimal Anthropic client surface used by {@link AnthropicBrain} (injectable in tests). */
export type AnthropicMessagesClient = {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
};

/** Options for constructing an {@link AnthropicBrain}. */
export type AnthropicBrainOptions = {
  config: BrainConfig;
  client?: AnthropicMessagesClient;
};

function httpStatusFromUnknown(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function reasonFromAnthropicStatus(status: number): BrainError["reason"] {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 402) {
    return "credit_exhausted";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "unavailable";
  }
  return "provider";
}

/**
 * Production Brain backed by the Anthropic Messages API.
 *
 * Maps the leading `system` {@link BrainMessage} to the API `system` parameter;
 * remaining messages are sent as `user` / `assistant` turns.
 */
export class AnthropicBrain implements Brain {
  private readonly config: AnthropicBrainConfig;
  private readonly client: AnthropicMessagesClient;

  constructor(options: AnthropicBrainOptions) {
    if (options.config.provider !== "anthropic") {
      throw new BrainError(
        `AnthropicBrain requires provider anthropic (got ${options.config.provider})`,
        "invalid_config",
        { envVar: "NPC_BRAIN_PROVIDER" }
      );
    }
    this.config = options.config;
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.config.apiKey,
        timeout: options.config.timeoutMs
      }).messages;
  }

  async complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<BrainResult> {
    const { system, conversation } = splitMessages(messages);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.config.model,
      max_tokens: opts?.maxTokens ?? this.config.maxTokens,
      messages: conversation
    };

    if (system !== undefined) {
      params.system = system;
    }
    if (opts?.temperature !== undefined) {
      params.temperature = opts.temperature;
    }
    if (opts?.stopSequences !== undefined) {
      params.stop_sequences = opts.stopSequences;
    }

    try {
      const response = await this.client.create(params);
      const textBlock = response.content.find((block) => block.type === "text");
      if (textBlock === undefined || textBlock.type !== "text") {
        throw new BrainError("Anthropic response contained no text block", "provider");
      }
      const usage =
        response.usage === undefined
          ? ZERO_BRAIN_USAGE
          : {
              promptTokens: response.usage.input_tokens,
              completionTokens: response.usage.output_tokens
            };
      return { text: textBlock.text, usage };
    } catch (error) {
      if (error instanceof BrainError) {
        throw error;
      }
      const status = httpStatusFromUnknown(error);
      const reason = status === undefined ? "provider" : reasonFromAnthropicStatus(status);
      throw new BrainError("Anthropic API request failed", reason, { cause: error });
    }
  }
}
