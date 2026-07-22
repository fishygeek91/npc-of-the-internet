import type { Timer } from "@npc/runtime";

type IntervalEntry = {
  handler: () => void;
  cleared: boolean;
};

/** Injectable timer: `tick()` fires each active interval once. */
export class FakeTimer implements Timer {
  private nextId = 1;
  private readonly intervals = new Map<number, IntervalEntry>();

  setInterval(handler: () => void, _ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.set(id, { handler, cleared: false });
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

  tick(): void {
    for (const entry of this.intervals.values()) {
      if (!entry.cleared) {
        entry.handler();
      }
    }
  }
}
