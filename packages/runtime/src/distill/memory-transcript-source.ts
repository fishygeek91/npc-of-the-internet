import type { TranscriptLine, TranscriptSource } from "./types.js";

/**
 * In-memory {@link TranscriptSource} for retryable depart after the on-disk
 * transcript has been destroyed for privacy.
 */
export class MemoryTranscriptSource implements TranscriptSource {
  private readonly lines: readonly TranscriptLine[];

  constructor(lines: readonly TranscriptLine[]) {
    this.lines = lines.map((line) => {
      const copy: TranscriptLine = {
        role: line.role,
        text: line.text
      };
      if (line.author_id !== undefined) {
        copy.author_id = line.author_id;
      }
      return copy;
    });
  }

  /**
   * Return a defensive copy of the cached transcript lines.
   */
  async read(): Promise<readonly TranscriptLine[]> {
    return this.lines.map((line) => {
      const copy: TranscriptLine = {
        role: line.role,
        text: line.text
      };
      if (line.author_id !== undefined) {
        copy.author_id = line.author_id;
      }
      return copy;
    });
  }

  /**
   * No-op: there is no on-disk transcript to unlink.
   */
  async destroy(): Promise<void> {
    return;
  }
}
