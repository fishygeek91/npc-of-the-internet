import { BrainError } from "./errors.js";
import type { BrainMessage } from "./types.js";

/** Split a Brain conversation into at most one system prompt plus user/assistant turns. */
export function splitMessages(messages: readonly BrainMessage[]): {
  system?: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
} {
  let system: string | undefined;
  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (system !== undefined) {
        throw new BrainError("Only one leading system message is supported", "invalid_request");
      }
      system = message.content;
      continue;
    }

    conversation.push({ role: message.role, content: message.content });
  }

  if (conversation.length === 0) {
    throw new BrainError("At least one user or assistant message is required", "invalid_request");
  }

  return system !== undefined ? { system, conversation } : { conversation };
}
