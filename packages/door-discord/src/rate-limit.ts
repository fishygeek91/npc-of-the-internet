/**
 * Millisecond clock for rate-limit refill (injectable in tests).
 */
export type RateClock = {
  nowMs(): number;
};

/** Constructor overrides for idle eviction (primarily for tests). */
export type DualRateLimiterOptions = {
  /** Evict user buckets idle longer than this (default 3_600_000 ms). */
  userIdleTtlMs?: number;
  /** Max tracked users before LRU eviction (default 4096). */
  maxUsers?: number;
};

const DEFAULT_USER_IDLE_TTL_MS = 3_600_000;
const DEFAULT_MAX_USERS = 4096;

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

  /**
   * Refill then report whether at least one token is available (no consumption).
   */
  hasToken(): boolean {
    this.refill();
    return this.tokens >= 1;
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

  /**
   * Refill and return floored token count (for tests and diagnostics).
   */
  tokenCount(): number {
    this.refill();
    return Math.floor(this.tokens);
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

type UserEntry = {
  bucket: TokenBucket;
  lastAccessMs: number;
};

/**
 * Dual token-bucket limiter: per-user and per-channel.
 * Dropped messages get no reply — callers log at debug and continue.
 */
export class DualRateLimiter {
  private readonly users = new Map<string, UserEntry>();
  private readonly channelBucket: TokenBucket;
  private readonly userIdleTtlMs: number;
  private readonly maxUsers: number;

  constructor(
    private readonly userRatePerMinute: number,
    private readonly userBurst: number,
    channelRatePerMinute: number,
    channelBurst: number,
    private readonly clock: RateClock,
    options: DualRateLimiterOptions = {}
  ) {
    this.channelBucket = new TokenBucket(channelRatePerMinute, channelBurst, clock);
    this.userIdleTtlMs = options.userIdleTtlMs ?? DEFAULT_USER_IDLE_TTL_MS;
    this.maxUsers = options.maxUsers ?? DEFAULT_MAX_USERS;
  }

  /**
   * Returns true when the message may proceed.
   * Channel capacity is checked first so a saturated channel never burns user tokens.
   */
  allow(userId: string): boolean {
    this.evictIdleUsers();

    if (!this.channelBucket.hasToken()) {
      return false;
    }

    const now = this.clock.nowMs();
    let entry = this.users.get(userId);
    if (entry === undefined) {
      entry = {
        bucket: new TokenBucket(this.userRatePerMinute, this.userBurst, this.clock),
        lastAccessMs: now
      };
      this.users.set(userId, entry);
      this.evictIdleUsers();
    } else {
      entry.lastAccessMs = now;
    }

    if (!entry.bucket.hasToken()) {
      return false;
    }

    const channelTaken = this.channelBucket.tryTake();
    const userTaken = entry.bucket.tryTake();
    if (!channelTaken || !userTaken) {
      return false;
    }
    return true;
  }

  /** Number of tracked user buckets (for tests). */
  userCount(): number {
    return this.users.size;
  }

  /**
   * Refilled floored user token count, or undefined when no bucket exists (test helper).
   */
  userTokenCount(userId: string): number | undefined {
    const entry = this.users.get(userId);
    if (entry === undefined) {
      return undefined;
    }
    return entry.bucket.tokenCount();
  }

  /** Remove idle users and enforce the LRU cap. */
  private evictIdleUsers(): void {
    const now = this.clock.nowMs();

    for (const [userId, entry] of this.users) {
      if (now - entry.lastAccessMs > this.userIdleTtlMs) {
        this.users.delete(userId);
      }
    }

    while (this.users.size > this.maxUsers) {
      let oldestUserId: string | undefined;
      let oldestAccessMs = Number.POSITIVE_INFINITY;
      for (const [userId, entry] of this.users) {
        if (entry.lastAccessMs < oldestAccessMs) {
          oldestAccessMs = entry.lastAccessMs;
          oldestUserId = userId;
        }
      }
      if (oldestUserId === undefined) {
        break;
      }
      this.users.delete(oldestUserId);
    }
  }
}
