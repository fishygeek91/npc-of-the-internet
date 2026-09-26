import type { TranscriptLine, TranscriptSource } from "./types.js";

/** Default cap on retained transcript lines (oldest dropped first). */
export const DEFAULT_TRANSCRIPT_MAX_LINES = 1500;

/** Default cap on retained transcript characters (oldest dropped first). */
export const DEFAULT_TRANSCRIPT_MAX_CHARS = 120_000;

/** Options for {@link ResidencyTranscript}. */
export type ResidencyTranscriptOptions = {
  maxLines?: number;
  maxChars?: number;
};

function copyLine(line: TranscriptLine): TranscriptLine {
  const copy: TranscriptLine = { role: line.role, text: line.text };
  if (line.author_id !== undefined) {
    copy.author_id = line.author_id;
  }
  return copy;
}

/**
 * Live, in-memory residency transcript (WHITEPAPER §3.2).
 *
 * The Session records every screened inbound message it observes — including ones the
 * Wanderer chose not to answer — plus everything the Wanderer said. It is **never written
 * to disk**: it exists only for the life of the residency process and is destroyed when
 * depart reads it. A bounded ring (lines + chars) keeps long residencies within one
 * distill call; the oldest lines fall away first.
 *
 * Crash caveat: a process restart loses the transcript (by design — raw conversation is
 * not durable). Depart after a restart distills only what was observed since boot.
 */
export class ResidencyTranscript implements TranscriptSource {
  private lines: TranscriptLine[] = [];
  private charCount = 0;
  private readonly maxLines: number;
  private readonly maxChars: number;

  constructor(options: ResidencyTranscriptOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_TRANSCRIPT_MAX_LINES;
    this.maxChars = options.maxChars ?? DEFAULT_TRANSCRIPT_MAX_CHARS;
  }

  /** Number of lines currently held. */
  get size(): number {
    return this.lines.length;
  }

  /** Append one line, evicting the oldest lines past the caps. */
  record(line: TranscriptLine): void {
    const copy = copyLine(line);
    this.lines.push(copy);
    this.charCount += copy.text.length;
    while (
      this.lines.length > 1 &&
      (this.lines.length > this.maxLines || this.charCount > this.maxChars)
    ) {
      const dropped = this.lines.shift();
      if (dropped !== undefined) {
        this.charCount -= dropped.text.length;
      }
    }
  }

  /** Defensive copy of the current lines. */
  async read(): Promise<readonly TranscriptLine[]> {
    return this.lines.map(copyLine);
  }

  /** Forget everything (privacy: called by depart after the one read). */
  async destroy(): Promise<void> {
    this.lines = [];
    this.charCount = 0;
  }
}
