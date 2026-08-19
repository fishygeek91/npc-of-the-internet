/**
 * A single message in a Brain conversation.
 *
 * Convention: pass at most one leading `system` message, followed by alternating
 * `user` and `assistant` messages. Implementations map the system message to
 * provider-specific system-instruction fields (e.g. Anthropic `system`, OpenAI
 * `role: "system"`).
 */
export type BrainMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Optional per-request overrides for a completion call. */
export type CompleteOptions = {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
};

/** Token counts reported by a provider (zeros when the provider omits usage). */
export type BrainUsage = {
  promptTokens: number;
  completionTokens: number;
};

/** Result of a Brain completion: assistant text plus token usage. */
export type BrainResult = {
  text: string;
  usage: BrainUsage;
};

/** Default usage when a provider or FakeBrain script does not supply counts. */
export const ZERO_BRAIN_USAGE: BrainUsage = {
  promptTokens: 0,
  completionTokens: 0
};

/**
 * Provider-agnostic LLM interface. All runtime LLM access goes through `Brain`.
 */
export interface Brain {
  /**
   * Run a chat completion and return assistant text plus token usage.
   *
   * @param messages - Conversation history; see {@link BrainMessage} for the
   *   leading `system` message convention.
   * @param opts - Optional per-request overrides (token limit, temperature, stops).
   */
  complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<BrainResult>;
}
