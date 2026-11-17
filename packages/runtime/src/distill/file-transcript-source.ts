import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { DistillError } from "./errors.js";
import type { TranscriptLine, TranscriptSource } from "./types.js";

const SAFE_BASENAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Which transcript IO step failed. */
export type TranscriptIoEvent = "transcript_read_failed" | "transcript_delete_failed";

/**
 * Server-side log for transcript IO.
 * Receives the filesystem path. {@link DistillError} messages stay path-free.
 */
export type TranscriptIoLog = (
  event: TranscriptIoEvent,
  fields: { path: string; detail: string }
) => void;

function defaultTranscriptIoLog(
  event: TranscriptIoEvent,
  fields: { path: string; detail: string }
): void {
  process.stderr.write(`runtime ${event}: ${fields.path}: ${fields.detail}\n`);
}

const TranscriptLineSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    author_id: z.string().optional()
  })
  .strict();

function assertSafeTranscriptPath(filePath: string): string {
  const segments = filePath.split(/[/\\]/);
  if (segments.includes("..")) {
    throw new DistillError("transcript path contains forbidden .. segment", "invalid_transcript");
  }

  const resolved = path.resolve(filePath);
  const base = path.basename(resolved);
  if (!SAFE_BASENAME_PATTERN.test(base)) {
    throw new DistillError("transcript filename contains unsafe characters", "invalid_transcript");
  }

  return resolved;
}

/**
 * Reads newline-delimited JSON transcript lines from a file; deletes on destroy.
 * IO failures throw a path-free {@link DistillError}. The path is logged, not returned.
 */
export class FileTranscriptSource implements TranscriptSource {
  readonly path: string;
  private readonly log: TranscriptIoLog;

  /**
   * @param filePath - Transcript file. `..` segments and unsafe basenames are rejected.
   * @param log - Server-side IO log. Defaults to stderr. Never included in the thrown error.
   */
  constructor(filePath: string, log?: TranscriptIoLog) {
    this.path = assertSafeTranscriptPath(filePath);
    this.log = log ?? defaultTranscriptIoLog;
  }

  async read(): Promise<readonly TranscriptLine[]> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : "read failed";
      this.log("transcript_read_failed", { path: this.path, detail });
      throw new DistillError("cannot read transcript", "invalid_transcript");
    }

    const lines: TranscriptLine[] = [];
    for (const [index, line] of contents.split("\n").entries()) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new DistillError(
          `malformed transcript JSON on line ${String(index + 1)}`,
          "invalid_transcript"
        );
      }

      const result = TranscriptLineSchema.safeParse(parsed);
      if (!result.success) {
        throw new DistillError(
          `invalid transcript line ${String(index + 1)}: does not match TranscriptLine schema`,
          "invalid_transcript"
        );
      }

      const entry: TranscriptLine = {
        role: result.data.role,
        text: result.data.text
      };
      if (result.data.author_id !== undefined) {
        entry.author_id = result.data.author_id;
      }
      lines.push(entry);
    }

    return lines;
  }

  async destroy(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      const detail = error instanceof Error ? error.message : "unlink failed";
      this.log("transcript_delete_failed", { path: this.path, detail });
      throw new DistillError("cannot delete transcript", "invalid_transcript");
    }
  }
}
