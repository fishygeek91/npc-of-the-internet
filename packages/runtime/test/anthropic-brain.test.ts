import { describe, expect, it, vi } from "vitest";

import { AnthropicBrain } from "../src/brain/anthropic-brain.js";
import { loadBrainConfig } from "../src/brain/config.js";
import { BrainError } from "../src/brain/errors.js";
import type { BrainMessage } from "../src/brain/types.js";

describe("loadBrainConfig", () => {
  it("loads defaults when optional vars are omitted", () => {
    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config).toEqual({
      apiKey: "sk-test",
      model: "claude-sonnet-4-20250514",
      maxTokens: 1024,
      timeoutMs: 60_000
    });
  });

  it("parses optional env overrides", () => {
    const config = loadBrainConfig({
      ANTHROPIC_API_KEY: "sk-test",
      NPC_BRAIN_MODEL: "claude-opus-4-20250514",
      NPC_BRAIN_MAX_TOKENS: "2048",
      NPC_BRAIN_TIMEOUT_MS: "30000"
    });
    expect(config.model).toBe("claude-opus-4-20250514");
    expect(config.maxTokens).toBe(2048);
    expect(config.timeoutMs).toBe(30_000);
  });

  it("throws BrainError when API key is missing", () => {
    expect(() => loadBrainConfig({})).toThrow(BrainError);
    expect(() => loadBrainConfig({})).toThrow(/ANTHROPIC_API_KEY is required/);
  });
});

describe("AnthropicBrain", () => {
  it("maps a leading system message to the API system parameter", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hello back" }]
    });

    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    const brain = new AnthropicBrain({ config, client: { create } });

    const messages: BrainMessage[] = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" }
    ];
    await expect(brain.complete(messages)).resolves.toBe("hello back");

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: config.model,
      max_tokens: config.maxTokens,
      system: "Be brief.",
      messages: [{ role: "user", content: "hi" }]
    });
  });

  it("applies per-request CompleteOptions overrides", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "done" }]
    });

    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    const brain = new AnthropicBrain({ config, client: { create } });

    await brain.complete([{ role: "user", content: "go" }], {
      maxTokens: 256,
      temperature: 0.2,
      stopSequences: ["END"]
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      max_tokens: 256,
      temperature: 0.2,
      stop_sequences: ["END"]
    });
  });

  it("wraps client failures in BrainError", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network down"));
    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    const brain = new AnthropicBrain({ config, client: { create } });

    await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toThrow(BrainError);
    await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toThrow(
      /Anthropic API request failed/
    );
  });

  it("rejects multiple system messages", async () => {
    const create = vi.fn();
    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    const brain = new AnthropicBrain({ config, client: { create } });

    await expect(
      brain.complete([
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "hi" }
      ])
    ).rejects.toThrow(/one leading system message/);
    expect(create).not.toHaveBeenCalled();
  });
});
