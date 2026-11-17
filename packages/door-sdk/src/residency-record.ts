/** One line of what happened in a residency, as the Door saw it. */
export type ResidencyLine = {
  /** `community`: relayed inbound; `wanderer`: delivered outbound. */
  role: "community" | "wanderer";
  /** Display name (or opaque id) of a community author. Untrusted. */
  author?: string;
  /** Message text. Untrusted. */
  text: string;
  /** ISO timestamp the Door handled the line. */
  at: string;
};

/**
 * Bounds for {@link ResidencyRecord}: a separate budget per role, so the Wanderer's own
 * words can never evict what the community said (and vice versa). Character budgets are
 * charged each line's rendered size ({@link residencyLineChars}), so many tiny lines with
 * long names cannot blow up the witness prompt.
 */
export type ResidencyRecordOptions = {
  /** Keep at most this many rendered characters of community lines, oldest dropped first (default 90 000). */
  communityChars?: number;
  /** Keep at most this many rendered characters of Wanderer lines, oldest dropped first (default 30 000). */
  wandererChars?: number;
  /** Keep at most this many community lines, oldest dropped first (default 2000). */
  communityLines?: number;
  /** Keep at most this many Wanderer lines, oldest dropped first (default 1000). */
  wandererLines?: number;
};

/** Default {@link ResidencyRecordOptions.communityChars}. */
export const DEFAULT_COMMUNITY_RECORD_CHARS = 90_000;

/** Default {@link ResidencyRecordOptions.wandererChars}. */
export const DEFAULT_WANDERER_RECORD_CHARS = 30_000;

/** Default {@link ResidencyRecordOptions.communityLines}. */
export const DEFAULT_COMMUNITY_RECORD_LINES = 2000;

/** Default {@link ResidencyRecordOptions.wandererLines}. */
export const DEFAULT_WANDERER_RECORD_LINES = 1000;

/** Longest community author name the witness prompt shows (longer names are cut). */
export const RECORD_AUTHOR_MAX = 64;

/**
 * Fixed per-line charge: at least the JSON keys, quotes, braces and newline the witness
 * prompt wraps around a line, so the charge is an upper bound on the rendered line.
 */
const LINE_OVERHEAD_CHARS = 40;

/**
 * Characters a line is charged against its role budget: its JSON-escaped text, plus the
 * (cut) JSON-escaped author for community lines, plus a fixed per-line overhead. Never less
 * than the line's size in the witness prompt.
 */
export function residencyLineChars(line: ResidencyLine): number {
  const author =
    line.role === "community"
      ? JSON.stringify((line.author ?? "someone").slice(0, RECORD_AUTHOR_MAX)).length
      : 0;
  return JSON.stringify(line.text).length + author + LINE_OVERHEAD_CHARS;
}

type Role = ResidencyLine["role"];

/**
 * The Door's own in-memory record of the active residency: the witness input
 * (`spec/door/api.md` §Memory witnessing). Bounded by rendered characters and lines per
 * role (most recent kept), never persisted, cleared when the epoch ends.
 */
export class ResidencyRecord {
  private readonly maxChars: Record<Role, number>;
  private readonly maxLines: Record<Role, number>;
  private readonly chars: Record<Role, number> = { community: 0, wanderer: 0 };
  private readonly counts: Record<Role, number> = { community: 0, wanderer: 0 };
  /** Entries with their charged size, oldest first. */
  private readonly entries: { line: ResidencyLine; cost: number }[] = [];

  constructor(options: ResidencyRecordOptions = {}) {
    this.maxChars = {
      community: positiveInteger(
        options.communityChars ?? DEFAULT_COMMUNITY_RECORD_CHARS,
        "communityChars"
      ),
      wanderer: positiveInteger(
        options.wandererChars ?? DEFAULT_WANDERER_RECORD_CHARS,
        "wandererChars"
      )
    };
    this.maxLines = {
      community: positiveInteger(
        options.communityLines ?? DEFAULT_COMMUNITY_RECORD_LINES,
        "communityLines"
      ),
      wanderer: positiveInteger(
        options.wandererLines ?? DEFAULT_WANDERER_RECORD_LINES,
        "wandererLines"
      )
    };
  }

  /** Append a line; drop the oldest lines of the same role while that role is over budget. */
  record(line: ResidencyLine): void {
    const role = line.role;
    const cost = residencyLineChars(line);
    this.entries.push({ line, cost });
    this.chars[role] += cost;
    this.counts[role] += 1;
    while (this.chars[role] > this.maxChars[role] || this.counts[role] > this.maxLines[role]) {
      const oldest = this.entries.findIndex((entry) => entry.line.role === role);
      if (oldest === this.entries.length - 1) {
        break; // A single over-long latest line is kept until the next line of its role.
      }
      const [dropped] = this.entries.splice(oldest, 1);
      this.chars[role] -= dropped?.cost ?? 0;
      this.counts[role] -= 1;
    }
  }

  /** Snapshot of the record, oldest first. */
  lines(): readonly ResidencyLine[] {
    return this.entries.map((entry) => entry.line);
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
    this.chars.community = 0;
    this.chars.wanderer = 0;
    this.counts.community = 0;
    this.counts.wanderer = 0;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`residencyRecord.${name} must be a positive integer`);
  }
  return value;
}
