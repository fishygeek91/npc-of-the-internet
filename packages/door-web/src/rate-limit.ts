/** Millisecond clock (injectable in tests). */
export type MsClock = { nowMs: () => number };

/** One sliding-window rule: at most `max` accepted events per `windowMs`. */
export type RateRule = { max: number; windowMs: number };

/** Outcome of {@link VisitorRateLimiter.take}. */
export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

/** Per-visitor rules from the spec: 1 message / 3 s and 20 / 10 min. */
export const VISITOR_RULES: readonly RateRule[] = [
  { max: 1, windowMs: 3_000 },
  { max: 20, windowMs: 600_000 }
];

/**
 * Sliding-window limiter for visitor messages: per-key rules plus one global rule.
 *
 * Only accepted events are recorded, so the number of tracked keys is bounded by the
 * global rule (a flood of rejected requests from many addresses costs no memory).
 */
export class VisitorRateLimiter {
  private readonly perKey = new Map<string, number[]>();
  private global: number[] = [];
  private readonly keyRules: readonly RateRule[];
  private readonly globalRule: RateRule;
  private readonly clock: MsClock;
  private readonly horizonMs: number;

  constructor(options: {
    globalPerMinute: number;
    clock: MsClock;
    keyRules?: readonly RateRule[];
  }) {
    this.keyRules = options.keyRules ?? VISITOR_RULES;
    this.globalRule = { max: options.globalPerMinute, windowMs: 60_000 };
    this.clock = options.clock;
    this.horizonMs = Math.max(...this.keyRules.map((rule) => rule.windowMs));
  }

  /** Check `key` (and the global budget); on success, record one event. */
  take(key: string): RateDecision {
    const now = this.clock.nowMs();
    this.sweep(now);
    const history = this.perKey.get(key) ?? [];
    let retryAfterMs = 0;
    for (const rule of this.keyRules) {
      retryAfterMs = Math.max(retryAfterMs, waitFor(history, rule, now));
    }
    retryAfterMs = Math.max(retryAfterMs, waitFor(this.global, this.globalRule, now));
    if (retryAfterMs > 0) {
      return { ok: false, retryAfterMs };
    }
    history.push(now);
    this.perKey.set(key, history);
    this.global.push(now);
    return { ok: true };
  }

  /** Number of keys currently tracked (diagnostics / tests). */
  trackedKeys(): number {
    return this.perKey.size;
  }

  private sweep(now: number): void {
    this.global = this.global.filter((at) => now - at < this.globalRule.windowMs);
    for (const [key, history] of this.perKey) {
      const kept = history.filter((at) => now - at < this.horizonMs);
      if (kept.length === 0) {
        this.perKey.delete(key);
      } else if (kept.length !== history.length) {
        this.perKey.set(key, kept);
      }
    }
  }
}

/** Milliseconds until `rule` admits one more event given `history` (0 = now). */
function waitFor(history: readonly number[], rule: RateRule, now: number): number {
  const recent = history.filter((at) => now - at < rule.windowMs);
  if (recent.length < rule.max) {
    return 0;
  }
  const oldestBlocking = recent[recent.length - rule.max] ?? now;
  return Math.max(1, oldestBlocking + rule.windowMs - now);
}

const DAY_MS = 86_400_000;

/**
 * At most `max` events per UTC day (bounds what visitors can cost in Wanderer model calls).
 * Check with {@link DailyBudget.check} first and {@link DailyBudget.record} only what was
 * actually spent.
 */
export class DailyBudget {
  private day = -1;
  private used = 0;

  constructor(
    private readonly max: number,
    private readonly clock: MsClock
  ) {}

  /** `ok` while today's budget has room; otherwise how long until the next UTC day. */
  check(): RateDecision {
    const now = this.clock.nowMs();
    this.roll(now);
    if (this.used < this.max) {
      return { ok: true };
    }
    return { ok: false, retryAfterMs: (this.day + 1) * DAY_MS - now };
  }

  /** Count one spent event against today. */
  record(): void {
    this.roll(this.clock.nowMs());
    this.used += 1;
  }

  private roll(now: number): void {
    const day = Math.floor(now / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
  }
}
