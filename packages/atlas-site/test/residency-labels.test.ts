import type { ResidencyEntry } from "@npc/atlas";
import { describe, expect, it } from "vitest";

import {
  recordKindLabel,
  residencyMemoryLine,
  residencyTravelLine
} from "../src/lib/residency-labels.js";

function residency(overrides: Partial<ResidencyEntry>): ResidencyEntry {
  return {
    residency: "door:web:home/epoch:3",
    door_id: "web:home",
    epoch: 3,
    arrived_at: "2026-01-04T00:00:00.000Z",
    departed_at: null,
    traveled_to: null,
    ended: null,
    counts: { witnessed: 0, declined: 0, screened: 0 },
    declined_reasons: [],
    journal: null,
    ...overrides
  };
}

describe("residencyMemoryLine", () => {
  it("states witnessed and declined counts in plain language", () => {
    const entry = residency({
      counts: { witnessed: 3, declined: 1, screened: 0 },
      declined_reasons: ["private"]
    });
    expect(residencyMemoryLine(entry)).toBe(
      "3 memories witnessed · 1 declined by the witness (private)"
    );
  });

  it("uses the singular, lists several reasons, and mentions screen drops", () => {
    const entry = residency({
      counts: { witnessed: 1, declined: 2, screened: 1 },
      declined_reasons: ["private", "ungrounded"]
    });
    expect(residencyMemoryLine(entry)).toBe(
      "1 memory witnessed · 2 declined by the witness (private, ungrounded) · 1 held back by the Wanderer's own screen"
    );
  });

  it("says zero memories when nothing was witnessed", () => {
    expect(residencyMemoryLine(residency({}))).toBe("0 memories witnessed");
  });
});

describe("residencyTravelLine", () => {
  it("names the next Door, falls back to 'left', and is null while still there", () => {
    expect(
      residencyTravelLine(
        residency({ departed_at: "2026-01-04T05:02:00.000Z", traveled_to: "discord:g" })
      )
    ).toBe("left for discord:g");
    expect(residencyTravelLine(residency({ departed_at: "2026-01-04T05:02:00.000Z" }))).toBe(
      "left"
    );
    expect(residencyTravelLine(residency({}))).toBeNull();
  });

  it("reads a superseded residency at the same Door as a restart, elsewhere as a move", () => {
    const superseded = residency({
      residency: "door:web:home/epoch:3",
      departed_at: "2026-01-04T02:00:00.000Z",
      ended: "superseded"
    });
    const restart = residency({ residency: "door:web:home/epoch:4", epoch: 4 });
    const moved = residency({
      residency: "door:discord:g/epoch:4",
      door_id: "discord:g",
      epoch: 4
    });
    expect(residencyTravelLine(superseded, restart)).toBe("(restarted)");
    expect(residencyTravelLine(superseded, moved)).toBe("left for discord:g");
    expect(residencyTravelLine(superseded)).toBe("left");
  });
});

describe("recordKindLabel", () => {
  it("labels legacy candidates and passes other kinds through", () => {
    expect(recordKindLabel("memory/candidate")).toBe("legacy candidate");
    expect(recordKindLabel("memory/shard")).toBe("memory/shard");
    expect(recordKindLabel("memory/journal")).toBe("memory/journal");
  });
});
