import { describe, expect, it } from "vitest";

import { DualRateLimiter, TokenBucket } from "../src/rate-limit.js";

describe("TokenBucket", () => {
  it("allows burst then denies until refill", () => {
    let now = 1_000;
    const clock = { nowMs: () => now };
    const bucket = new TokenBucket(60, 2, clock);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    now += 60_000;
    expect(bucket.tryTake()).toBe(true);
  });
});

describe("DualRateLimiter", () => {
  it("enforces per-user and per-channel bursts", () => {
    const now = 0;
    const clock = { nowMs: () => now };
    const limiter = new DualRateLimiter(60, 2, 60, 3, clock);
    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.allow("u1")).toBe(false);
    // Different user still limited by channel burst remaining (1 left of 3).
    expect(limiter.allow("u2")).toBe(true);
    expect(limiter.allow("u2")).toBe(false);
  });
});
