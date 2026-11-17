import { describe, expect, it } from "vitest";

import { ChainMismatchError, VerificationError } from "../src/errors.js";
import { appendRejectionError } from "../src/verify-chain.js";

describe("appendRejectionError", () => {
  it("uses append_rejected when the failure list is empty", () => {
    const error = appendRejectionError([]);
    expect(error).toBeInstanceOf(VerificationError);
    expect(error).toMatchObject({
      reason: "append_rejected",
      message: "append rejected by chain verification"
    });
  });

  it("keeps structural rules on ChainMismatchError", () => {
    const error = appendRejectionError([
      { seq: 2, rule: "seq_gap", message: "expected seq 1, found 2" }
    ]);
    expect(error).toBeInstanceOf(ChainMismatchError);
    expect(error.message).toBe("append rejected: seq_gap at seq 2: expected seq 1, found 2");
  });

  it("maps a non-structural rule to append_rejected and keeps the message", () => {
    const error = appendRejectionError([
      { seq: 1, rule: "bad_soul_sig", message: "soul signature verification failed" }
    ]);
    expect(error).toBeInstanceOf(VerificationError);
    expect(error).toMatchObject({
      reason: "append_rejected",
      message: "append rejected: bad_soul_sig at seq 1: soul signature verification failed"
    });
  });
});
