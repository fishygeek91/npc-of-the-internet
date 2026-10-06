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
 * Bounds for {@link ResidencyRecord}: a separate character budget per role, so the
 * Wanderer's own words can never evict what the community said (and vice versa).
 */
export type ResidencyRecordOptions = {
  /** Keep at most this many characters of community text, oldest dropped first (default 90 000). */
  communityChars?: number;
  /** Keep at most this many characters of Wanderer text, oldest dropped first (default 30 000). */
  wandererChars?: number;
};

/** Default {@link ResidencyRecordOptions.communityChars}. */
export const DEFAULT_COMMUNITY_RECORD_CHARS = 90_000;

/** Default {@link ResidencyRecordOptions.wandererChars}. */
export const DEFAULT_WANDERER_RECORD_CHARS = 30_000;

/**
 * The Door's own in-memory record of the active residency: the witness input
 * (`spec/door/api.md` §Memory witnessing). Bounded by characters per role (most recent
 * kept), never persisted, cleared when the epoch ends.
 */
export class ResidencyRecord {
  private readonly maxChars: Record<ResidencyLine["role"], number>;
  private readonly chars: Record<ResidencyLine["role"], number> = { community: 0, wanderer: 0 };
  private readonly entries: ResidencyLine[] = [];

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
  }

  /** Append a line; drop the oldest lines of the same role while that role is over budget. */
  record(line: ResidencyLine): void {
    const role = line.role;
    this.entries.push(line);
    this.chars[role] += line.text.length;
    while (this.chars[role] > this.maxChars[role]) {
      const oldest = this.entries.findIndex((entry) => entry.role === role);
      if (oldest === this.entries.length - 1) {
        break; // A single over-long latest line is kept until the next line of its role.
      }
      const [dropped] = this.entries.splice(oldest, 1);
      this.chars[role] -= dropped?.text.length ?? 0;
    }
  }

  /** Snapshot of the record, oldest first. */
  lines(): readonly ResidencyLine[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
    this.chars.community = 0;
    this.chars.wanderer = 0;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`residencyRecord.${name} must be a positive integer`);
  }
  return value;
}
