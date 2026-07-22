import type { Clock } from "@npc/door-sdk";

import type { RateClock } from "../../src/rate-limit.js";

/**
 * Combined Door clock + rate-limit millisecond clock for tests.
 */
export class TestClock implements Clock, RateClock {
  private iso: string;
  private ms: number;

  constructor(iso: string) {
    this.iso = iso;
    this.ms = Date.parse(iso);
  }

  now(): string {
    return this.iso;
  }

  nowMs(): number {
    return this.ms;
  }

  /** Advance simulated wall time (ISO stays fixed unless {@link setIso} is used). */
  advanceMs(delta: number): void {
    this.ms += delta;
  }

  setIso(iso: string): void {
    this.iso = iso;
    this.ms = Date.parse(iso);
  }
}
