/**
 * Millisecond clock for rate-limit refill (injectable in tests).
 */
export type RateClock = {
  nowMs(): number;
};

/**
 * Token-bucket rate limiter with injected clock (no `Date.now()` in logic).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerMinute: number,
    private readonly burst: number,
    private readonly clock: RateClock
  ) {
    this.tokens = burst;
    this.lastRefillMs = clock.nowMs();
  }

  /** Try to consume one token. Returns false when the bucket is empty. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = this.clock.nowMs();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }
    const tokensToAdd = (elapsedMs / 60_000) * this.ratePerMinute;
    this.tokens = Math.min(this.burst, this.tokens + tokensToAdd);
    this.lastRefillMs = now;
  }
}

/**
 * Dual token-bucket limiter: per-user and per-channel.
 * Dropped messages get no reply — callers log at debug and continue.
 */
export class DualRateLimiter {
  private readonly users = new Map<string, TokenBucket>();
  private readonly channelBucket: TokenBucket;

  constructor(
    private readonly userRatePerMinute: number,
    private readonly userBurst: number,
    channelRatePerMinute: number,
    channelBurst: number,
    private readonly clock: RateClock
  ) {
    this.channelBucket = new TokenBucket(channelRatePerMinute, channelBurst, clock);
  }

  /** Returns true when the message may proceed. */
  allow(userId: string): boolean {
    let userBucket = this.users.get(userId);
    if (userBucket === undefined) {
      userBucket = new TokenBucket(this.userRatePerMinute, this.userBurst, this.clock);
      this.users.set(userId, userBucket);
    }
    if (!userBucket.tryTake()) {
      return false;
    }
    return this.channelBucket.tryTake();
  }
}
