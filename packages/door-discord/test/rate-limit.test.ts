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

  it("hasToken reports availability without consuming", () => {
    const now = 0;
    const clock = { nowMs: () => now };
    const bucket = new TokenBucket(60, 2, clock);
    expect(bucket.hasToken()).toBe(true);
    expect(bucket.tokenCount()).toBe(2);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.hasToken()).toBe(true);
    expect(bucket.tokenCount()).toBe(1);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.hasToken()).toBe(false);
    expect(bucket.tokenCount()).toBe(0);
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

  it("does not burn user tokens when channel is saturated", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const limiter = new DualRateLimiter(60, 2, 60, 1, clock);

    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.userTokenCount("u1")).toBe(1);

    expect(limiter.allow("u1")).toBe(false);
    expect(limiter.userTokenCount("u1")).toBe(1);

    expect(limiter.allow("u2")).toBe(false);
    expect(limiter.userCount()).toBe(1);
    expect(limiter.userTokenCount("u2")).toBeUndefined();

    now += 60_000;

    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.allow("u1")).toBe(false);
    expect(limiter.userTokenCount("u1")).toBe(1);
  });

  it("evicts idle users after TTL", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const limiter = new DualRateLimiter(60, 3, 60, 10, clock, {
      userIdleTtlMs: 1_000
    });

    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.userCount()).toBe(1);
    expect(limiter.userTokenCount("u1")).toBe(2);

    now += 1_001;
    expect(limiter.allow("u2")).toBe(true);
    expect(limiter.userCount()).toBe(1);
    expect(limiter.userTokenCount("u1")).toBeUndefined();
    expect(limiter.userTokenCount("u2")).toBe(2);
  });

  it("evicts oldest user when maxUsers is exceeded", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const limiter = new DualRateLimiter(60, 3, 60, 100, clock, {
      maxUsers: 2
    });

    expect(limiter.allow("u1")).toBe(true);
    now += 1;
    expect(limiter.allow("u2")).toBe(true);
    now += 1;
    expect(limiter.allow("u3")).toBe(true);

    expect(limiter.userCount()).toBe(2);
    expect(limiter.userTokenCount("u1")).toBeUndefined();
    expect(limiter.userTokenCount("u2")).toBeDefined();
    expect(limiter.userTokenCount("u3")).toBeDefined();
  });
});
