import { describe, expect, it } from "vitest";

import { BrainError, brainErrorLogFields } from "../src/brain/errors.js";

describe("brainErrorLogFields", () => {
  it("returns reason and numeric status only", () => {
    const error = new BrainError("Anthropic API request failed", "rate_limited", {
      cause: {
        status: 429,
        type: "APIError",
        headers: { authorization: "Bearer secret", "x-api-key": "sk-ant-secret" },
        body: "over quota",
        request: { messages: ["private transcript"] }
      }
    });

    const fields = brainErrorLogFields(error);

    expect(fields).toEqual({ reason: "rate_limited", status: 429 });
    expect(Object.keys(fields)).toEqual(["reason", "status"]);
    expect(JSON.stringify(fields).includes("secret")).toBe(false);
    expect(JSON.stringify(fields).includes("over quota")).toBe(false);
    expect(JSON.stringify(fields).includes("private transcript")).toBe(false);
  });

  it("omits status when the cause has no finite numeric status", () => {
    const missing = new BrainError("OpenAI-compatible API request failed", "unavailable", {
      cause: { type: "TypeError", headers: { authorization: "Bearer secret" } }
    });
    const textual = new BrainError("Anthropic API request failed", "provider", {
      cause: { status: "429", body: "nope" }
    });

    expect(brainErrorLogFields(missing)).toEqual({ reason: "unavailable" });
    expect(brainErrorLogFields(textual)).toEqual({ reason: "provider" });
    expect(Object.keys(brainErrorLogFields(missing))).toEqual(["reason"]);
  });
});
