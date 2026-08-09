import { describe, expect, it } from "vitest";

import { recordVerified } from "../src/lib/verification.js";

describe("recordVerified", () => {
  it("marks every record verified when the chain is valid", () => {
    expect(recordVerified(0, { valid: true, head: null })).toBe(true);
    expect(recordVerified(99, { valid: true, head: null })).toBe(true);
  });

  it("fails closed when valid is false and failures is empty", () => {
    expect(recordVerified(0, { valid: false, failures: [] })).toBe(false);
    expect(recordVerified(5, { valid: false, failures: [] })).toBe(false);
  });

  it("splits verified prefix at the earliest failure seq", () => {
    const result = {
      valid: false as const,
      failures: [
        {
          seq: 5,
          rule: "bad_signature",
          message: "tampered"
        }
      ]
    };
    expect(recordVerified(4, result)).toBe(true);
    expect(recordVerified(5, result)).toBe(false);
    expect(recordVerified(6, result)).toBe(false);
  });
});
