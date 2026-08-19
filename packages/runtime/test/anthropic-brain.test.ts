import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AnthropicBrain } from "../src/brain/anthropic-brain.js";
import { loadBrainConfig } from "../src/brain/config.js";
import { BrainError } from "../src/brain/errors.js";
import type { BrainMessage } from "../src/brain/types.js";

describe("loadBrainConfig", () => {
  it("loads defaults when optional vars are omitted", () => {
    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config).toEqual({
      provider: "anthropic",
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

  it("loads API key from ANTHROPIC_API_KEY_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "npc-brain-key-"));
    const keyPath = join(dir, "api-key");
    writeFileSync(keyPath, "  sk-from-file  \n");

    const config = loadBrainConfig({ ANTHROPIC_API_KEY_FILE: keyPath });
    expect(config.provider).toBe("anthropic");
    if (config.provider === "anthropic") {
      expect(config.apiKey).toBe("sk-from-file");
    }
  });

  it("throws when both ANTHROPIC_API_KEY and ANTHROPIC_API_KEY_FILE are set", () => {
    expect(() =>
      loadBrainConfig({
        ANTHROPIC_API_KEY: "sk-direct",
        ANTHROPIC_API_KEY_FILE: "/tmp/key"
      })
    ).toThrow(BrainError);
    expect(() =>
      loadBrainConfig({
        ANTHROPIC_API_KEY: "sk-direct",
        ANTHROPIC_API_KEY_FILE: "/tmp/key"
      })
    ).toThrow(/set only one of ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_FILE/);
  });

  it("throws when ANTHROPIC_API_KEY_FILE points to an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "npc-brain-key-"));
    const keyPath = join(dir, "empty-key");
    writeFileSync(keyPath, "   \n");

    expect(() => loadBrainConfig({ ANTHROPIC_API_KEY_FILE: keyPath })).toThrow(BrainError);
    expect(() => loadBrainConfig({ ANTHROPIC_API_KEY_FILE: keyPath })).toThrow(
      /ANTHROPIC_API_KEY_FILE at .+ is empty/
    );
  });
});

describe("AnthropicBrain", () => {
  it("maps a leading system message to the API system parameter", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hello back" }],
      usage: { input_tokens: 12, output_tokens: 3 }
    });

    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    const brain = new AnthropicBrain({ config, client: { create } });

    const messages: BrainMessage[] = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" }
    ];
    await expect(brain.complete(messages)).resolves.toEqual({
      text: "hello back",
      usage: { promptTokens: 12, completionTokens: 3 }
    });

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
    await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      reason: "provider"
    });
  });

  it("maps HTTP 401 from the SDK to BrainError reason auth", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    const brain = new AnthropicBrain({ config, client: { create } });

    await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      name: "BrainError",
      reason: "auth"
    });
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
