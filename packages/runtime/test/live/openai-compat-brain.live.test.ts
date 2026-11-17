import { describe, expect, it } from "vitest";

import { loadBrainConfig } from "../../src/brain/config.js";
import { OpenAICompatBrain } from "../../src/brain/openai-compat-brain.js";

describe.skipIf(!process.env.LIVE_TESTS || process.env.NPC_BRAIN_PROVIDER !== "openai-compat")(
  "OpenAICompatBrain live",
  () => {
    it("returns a non-empty completion with usage", async () => {
      const config = loadBrainConfig();
      const brain = new OpenAICompatBrain({ config });

      const result = await brain.complete([
        { role: "user", content: "Reply with exactly one word: ok" }
      ]);

      expect(typeof result.text).toBe("string");
      expect(result.text.trim().length).toBeGreaterThan(0);
      expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
    });
  }
);
