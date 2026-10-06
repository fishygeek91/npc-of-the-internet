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

/** Bounds for {@link ResidencyRecord}. */
export type ResidencyRecordOptions = {
  /** Keep at most this many characters of text, oldest dropped first (default 120 000). */
  maxChars?: number;
};

/** Default {@link ResidencyRecordOptions.maxChars}. */
export const DEFAULT_RESIDENCY_RECORD_CHARS = 120_000;

/**
 * The Door's own in-memory record of the active residency: the witness input
 * (`spec/door/api.md` §Memory witnessing). Bounded by characters (most recent kept),
 * never persisted, cleared when the epoch ends.
 */
export class ResidencyRecord {
  private readonly maxChars: number;
  private readonly entries: ResidencyLine[] = [];
  private chars = 0;

  constructor(options: ResidencyRecordOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_RESIDENCY_RECORD_CHARS;
    if (!Number.isSafeInteger(this.maxChars) || this.maxChars < 1) {
      throw new RangeError("residencyRecord.maxChars must be a positive integer");
    }
  }

  record(line: ResidencyLine): void {
    this.entries.push(line);
    this.chars += line.text.length;
    while (this.chars > this.maxChars && this.entries.length > 1) {
      const dropped = this.entries.shift();
      if (dropped !== undefined) {
        this.chars -= dropped.text.length;
      }
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
    this.chars = 0;
  }
}
