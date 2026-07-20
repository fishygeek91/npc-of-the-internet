export const packageName = "@npc/runtime";

export type { BrainConfig } from "./brain/config.js";
export { loadBrainConfig } from "./brain/config.js";
export { AnthropicBrain } from "./brain/anthropic-brain.js";
export type { AnthropicBrainOptions, AnthropicMessagesClient } from "./brain/anthropic-brain.js";
export { BrainError } from "./brain/errors.js";
export { FakeBrain } from "./brain/fake-brain.js";
export type { FakeBrainCall, FakeBrainHandler } from "./brain/fake-brain.js";
export type { Brain, BrainMessage, CompleteOptions } from "./brain/types.js";
