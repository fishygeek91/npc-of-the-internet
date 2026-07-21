import type { Clock, Timer } from "../../src/session/types.js";

/**
 * Injectable clock for tests. Returns a fixed ISO 8601 UTC string until `set` changes it.
 */
export class FakeClock implements Clock {
  private currentIso: string;

  constructor(currentIso: string) {
    this.currentIso = currentIso;
  }

  /** Current simulated time as an ISO 8601 UTC string. */
  now(): string {
    return this.currentIso;
  }

  /** Jump the simulated clock to `iso`. */
  set(iso: string): void {
    this.currentIso = iso;
  }
}

type IntervalEntry = {
  handler: () => void;
  ms: number;
  cleared: boolean;
};

/**
 * Injectable timer for tests. `tick()` invokes every active interval handler once
 * (simulates one period elapsed) without real sleeps.
 */
export class FakeTimer implements Timer {
  private nextId = 1;
  private readonly intervals = new Map<number, IntervalEntry>();

  setInterval(handler: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.set(id, { handler, ms, cleared: false });
    return id;
  }

  clearInterval(id: unknown): void {
    if (typeof id !== "number") {
      return;
    }
    const entry = this.intervals.get(id);
    if (entry !== undefined) {
      entry.cleared = true;
    }
  }

  /** Invoke all active interval handlers once (simulates one period elapsed). */
  tick(): void {
    for (const entry of this.intervals.values()) {
      if (!entry.cleared) {
        entry.handler();
      }
    }
  }
}
