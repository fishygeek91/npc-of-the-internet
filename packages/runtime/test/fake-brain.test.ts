import { describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { BrainError } from "../src/brain/errors.js";
import type { BrainMessage } from "../src/brain/types.js";

describe("FakeBrain", () => {
  it("returns scripted responses in order", async () => {
    const brain = new FakeBrain(["first", "second"]);
    await expect(brain.complete([{ role: "user", content: "hi" }])).resolves.toBe("first");
    await expect(brain.complete([{ role: "user", content: "again" }])).resolves.toBe("second");
  });

  it("records calls with messages and opts", async () => {
    const brain = new FakeBrain(["ok"]);
    const messages: BrainMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" }
    ];
    await brain.complete(messages, { maxTokens: 128, temperature: 0.5 });

    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0]?.messages).toEqual(messages);
    expect(brain.calls[0]?.opts).toEqual({ maxTokens: 128, temperature: 0.5 });
  });

  it("delegates to a handler function", async () => {
    const brain = new FakeBrain((messages) => `echo:${messages.at(-1)?.content ?? ""}`);
    await expect(brain.complete([{ role: "user", content: "ping" }])).resolves.toBe("echo:ping");
  });

  it("throws a clear error when the script is exhausted", async () => {
    const brain = new FakeBrain(["only"]);
    await brain.complete([{ role: "user", content: "one" }]);

    await expect(brain.complete([{ role: "user", content: "two" }])).rejects.toThrow(BrainError);
    await expect(brain.complete([{ role: "user", content: "two" }])).rejects.toThrow(
      /script exhausted/
    );
  });
});
