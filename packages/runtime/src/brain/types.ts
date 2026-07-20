/**
 * A single message in a Brain conversation.
 *
 * Convention: pass at most one leading `system` message, followed by alternating
 * `user` and `assistant` messages. Implementations map the system message to
 * provider-specific system-instruction fields (e.g. Anthropic `system`).
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

/**
 * Provider-agnostic LLM interface. All runtime LLM access goes through `Brain`.
 */
export interface Brain {
  /**
   * Run a chat completion and return the assistant text.
   *
   * @param messages - Conversation history; see {@link BrainMessage} for the
   *   leading `system` message convention.
   * @param opts - Optional per-request overrides (token limit, temperature, stops).
   */
  complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<string>;
}
