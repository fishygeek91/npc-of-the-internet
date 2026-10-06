import type { ResidencyEntry } from "@npc/atlas";

/** `1 memory` / `3 memories`. */
function memories(count: number): string {
  return `${count} ${count === 1 ? "memory" : "memories"}`;
}

/**
 * Plain-language memory outcome for one residency, e.g.
 * `3 memories witnessed · 1 declined by the witness (private)`.
 * Screen drops (the Wanderer's own filter, before any witnessing) are appended when present.
 */
export function residencyMemoryLine(entry: ResidencyEntry): string {
  const parts = [`${memories(entry.counts.witnessed)} witnessed`];
  if (entry.counts.declined > 0) {
    const reasons =
      entry.declined_reasons.length === 0 ? "" : ` (${entry.declined_reasons.join(", ")})`;
    parts.push(`${entry.counts.declined} declined by the witness${reasons}`);
  }
  if (entry.counts.screened > 0) {
    parts.push(`${entry.counts.screened} held back by the Wanderer's own screen`);
  }
  return parts.join(" · ");
}

/**
 * Travel line for a residency: `left for web:home`, `left` when the destination is
 * not recorded, or null while the Wanderer is still there.
 */
export function residencyTravelLine(entry: ResidencyEntry): string | null {
  if (entry.traveled_to !== null) {
    return `left for ${entry.traveled_to}`;
  }
  return entry.departed_at === null ? null : "left";
}

/**
 * Explorer label for a record kind. Legacy `memory/candidate` records (from before
 * witnessed memory) read as `legacy candidate`; every other kind is shown as-is.
 */
export function recordKindLabel(kind: string): string {
  return kind === "memory/candidate" ? "legacy candidate" : kind;
}
