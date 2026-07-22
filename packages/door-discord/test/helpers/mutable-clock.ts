import type { Clock } from "@npc/door-sdk";

import type { RateClock } from "../../src/rate-limit.js";
import type { ReviewGateClock } from "../../src/review-gate.js";

/**
 * Injectable wall clock for rate limits, review timeouts, and Door timestamps.
 */
export class MutableClock implements Clock, RateClock, ReviewGateClock {
  constructor(private currentMs = 0) {}

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  nowMs(): number {
    return this.currentMs;
  }

  /** Jump the simulated clock forward by `deltaMs`. */
  advance(deltaMs: number): void {
    this.currentMs += deltaMs;
  }

  /** Set the simulated clock to an absolute millisecond value. */
  set(ms: number): void {
    this.currentMs = ms;
  }
}
