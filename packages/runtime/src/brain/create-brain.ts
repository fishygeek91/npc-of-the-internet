import { AnthropicBrain } from "./anthropic-brain.js";
import type { BrainConfig } from "./config.js";
import { BrainError } from "./errors.js";
import { OpenAICompatBrain } from "./openai-compat-brain.js";
import type { Brain } from "./types.js";

/**
 * Construct the production Brain for a validated config.
 *
 * `fake` is valid in {@link loadBrainConfig} for tests only — this factory
 * refuses it. Tests construct {@link FakeBrain} directly.
 */
export function createBrain(config: BrainConfig): Brain {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicBrain({ config });
    case "openai-compat":
      return new OpenAICompatBrain({ config });
    case "fake":
      throw new BrainError(
        "NPC_BRAIN_PROVIDER=fake is not valid for production; inject FakeBrain in tests",
        "invalid_config",
        { envVar: "NPC_BRAIN_PROVIDER" }
      );
    default: {
      const _exhaustive: never = config;
      throw new BrainError(`unsupported Brain provider: ${String(_exhaustive)}`, "invalid_config", {
        envVar: "NPC_BRAIN_PROVIDER"
      });
    }
  }
}
