import Anthropic from "@anthropic-ai/sdk";

import type { BrainConfig } from "./config.js";
import { BrainError } from "./errors.js";
import type { Brain, BrainMessage, CompleteOptions } from "./types.js";

/** Minimal Anthropic client surface used by {@link AnthropicBrain} (injectable in tests). */
export type AnthropicMessagesClient = {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
};

/** Options for constructing an {@link AnthropicBrain}. */
export type AnthropicBrainOptions = {
  config: BrainConfig;
  client?: AnthropicMessagesClient;
};

function splitMessages(messages: BrainMessage[]): {
  system?: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
} {
  let system: string | undefined;
  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (system !== undefined) {
        throw new BrainError("Only one leading system message is supported");
      }
      system = message.content;
      continue;
    }

    conversation.push({ role: message.role, content: message.content });
  }

  return system !== undefined ? { system, conversation } : { conversation };
}

/**
 * Production Brain backed by the Anthropic Messages API.
 *
 * Maps the leading `system` {@link BrainMessage} to the API `system` parameter;
 * remaining messages are sent as `user` / `assistant` turns.
 */
export class AnthropicBrain implements Brain {
  private readonly config: BrainConfig;
  private readonly client: AnthropicMessagesClient;

  constructor(options: AnthropicBrainOptions) {
    this.config = options.config;
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.config.apiKey,
        timeout: options.config.timeoutMs
      }).messages;
  }

  async complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<string> {
    const { system, conversation } = splitMessages(messages);

    if (conversation.length === 0) {
      throw new BrainError("At least one user or assistant message is required");
    }

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
        throw new BrainError("Anthropic response contained no text block");
      }
      return textBlock.text;
    } catch (error) {
      if (error instanceof BrainError) {
        throw error;
      }
      throw new BrainError("Anthropic API request failed", error);
    }
  }
}
