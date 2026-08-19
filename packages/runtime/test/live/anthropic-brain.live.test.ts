import { describe, expect, it } from "vitest";

import { AnthropicBrain } from "../../src/brain/anthropic-brain.js";
import { loadBrainConfig } from "../../src/brain/config.js";

describe.skipIf(!process.env.LIVE_TESTS)("AnthropicBrain live", () => {
  it("returns a non-empty completion", async () => {
    const config = loadBrainConfig();
    const brain = new AnthropicBrain({ config });

    const result = await brain.complete([
      { role: "user", content: "Reply with exactly one word: ok" }
    ]);

    expect(typeof result.text).toBe("string");
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
  });
});
