import { screenText } from "@npc/immune";
import type { ScreenCategory } from "@npc/immune";
import type { Brain, BrainMessage } from "../brain/types.js";
import { DISTILLER_RETRY } from "../prompts/distiller/retry.js";
import { DISTILLER_SYSTEM } from "../prompts/distiller/system.js";
import { DistillError } from "./errors.js";
import { parseBrainShards } from "./parse.js";
import type { CandidateShard, DistillOptions, TranscriptLine, TranscriptSource } from "./types.js";

const MIN_SHARDS = 1;
const MAX_SHARDS = 20;
/**
 * Max shard length in UTF-16 code units (`String.length`). Stricter than the side-blob
 * limit of 500 code points, so every shard that passes here encodes as a shard blob.
 */
const MAX_SHARD_UTF16_UNITS = 500;

type ParsedShard = { text: string; tags?: string[] };

/**
 * Format one transcript line for the distiller user prompt.
 */
function formatTranscriptLine(line: TranscriptLine): string {
  const authorSuffix = line.author_id !== undefined ? ` (${line.author_id})` : "";
  return `[${line.role}]${authorSuffix}: ${line.text}`;
}

/**
 * Build the distiller user-message body from screened transcript lines.
 */
function buildUserContent(lines: readonly TranscriptLine[]): string {
  const body = lines.map(formatTranscriptLine).join("\n");
  return `${body}\n\nDistill this residency into memory shards. Respond with JSON only.`;
}

/**
 * Build the Brain message list for a distill attempt.
 */
function buildMessages(userContent: string): BrainMessage[] {
  return [
    { role: "system", content: DISTILLER_SYSTEM },
    { role: "user", content: userContent }
  ];
}

/**
 * Drop transcript lines that fail {@link screenText}; report categories only.
 */
function screenTranscriptLines(
  lines: readonly TranscriptLine[],
  opts: DistillOptions | undefined
): { lines: TranscriptLine[]; droppedCategories: ScreenCategory[] } {
  const onScreenReject = opts?.onScreenReject;
  const kept: TranscriptLine[] = [];
  const droppedCategories: ScreenCategory[] = [];

  for (const line of lines) {
    const screenResult =
      opts?.piiAllowlist === undefined
        ? screenText(line.text)
        : screenText(line.text, { allowlist: opts.piiAllowlist });
    if (!screenResult.ok) {
      for (const category of screenResult.categories) {
        onScreenReject?.(category);
        if (!droppedCategories.includes(category)) {
          droppedCategories.push(category);
        }
      }
      continue;
    }
    kept.push(line);
  }

  return { lines: kept, droppedCategories };
}

/**
 * Parse Brain output; one malformed-output retry with the distiller retry prompt.
 */
async function completeWithRetry(
  brain: Brain,
  userContent: string,
  initialRaw: string
): Promise<ParsedShard[]> {
  try {
    return parseBrainShards(initialRaw);
  } catch (error: unknown) {
    if (!(error instanceof DistillError) || error.reason !== "malformed_output") {
      throw error;
    }

    const retryUserContent = DISTILLER_RETRY.replaceAll("{{error}}", () => error.message);
    const retryMessages: BrainMessage[] = [
      { role: "system", content: DISTILLER_SYSTEM },
      { role: "user", content: userContent },
      { role: "assistant", content: initialRaw },
      { role: "user", content: retryUserContent }
    ];

    const retryRaw = (await brain.complete(retryMessages)).text;
    try {
      return parseBrainShards(retryRaw);
    } catch (retryError: unknown) {
      if (retryError instanceof DistillError && retryError.reason === "malformed_output") {
        throw new DistillError(
          "distiller output is not valid JSON after retry",
          "malformed_output"
        );
      }
      throw retryError;
    }
  }
}

/**
 * Drop empty and over-length shards (reject, do not truncate).
 */
function filterLengthAndEmpty(shards: readonly ParsedShard[]): ParsedShard[] {
  const usable: ParsedShard[] = [];
  for (const shard of shards) {
    if (shard.text.trim().length === 0) {
      continue;
    }
    if (shard.text.length > MAX_SHARD_UTF16_UNITS) {
      continue;
    }
    usable.push(shard);
  }
  return usable;
}

/**
 * Screen output shards; drop failures and collect unique categories.
 */
function applyImmuneScreen(
  shards: readonly ParsedShard[],
  opts: DistillOptions | undefined
): { shards: ParsedShard[]; droppedCategories: ScreenCategory[] } {
  const onScreenReject = opts?.onScreenReject;
  const kept: ParsedShard[] = [];
  const droppedCategories: ScreenCategory[] = [];

  for (const shard of shards) {
    const screenResult =
      opts?.piiAllowlist === undefined
        ? screenText(shard.text)
        : screenText(shard.text, { allowlist: opts.piiAllowlist });
    if (!screenResult.ok) {
      for (const category of screenResult.categories) {
        onScreenReject?.(category);
        if (!droppedCategories.includes(category)) {
          droppedCategories.push(category);
        }
      }
      continue;
    }
    kept.push(shard);
  }

  return { shards: kept, droppedCategories };
}

/**
 * Drop repeated shard texts (first wins): each memory is witnessed and recorded once.
 */
function dedupeShards(shards: readonly ParsedShard[]): CandidateShard[] {
  const seen = new Set<string>();
  const unique: CandidateShard[] = [];
  for (const shard of shards) {
    if (seen.has(shard.text)) {
      continue;
    }
    seen.add(shard.text);
    unique.push(
      shard.tags === undefined ? { text: shard.text } : { text: shard.text, tags: shard.tags }
    );
  }
  return unique;
}

/**
 * Distill a residency transcript into 1–20 immune-screened, distinct candidate memory
 * shards (short stays yield few). Throws {@link DistillError} (`too_few_shards` /
 * `screen_reject`) when none survive, `invalid_transcript` when the screen drops every line.
 * Screens each transcript line before the Brain call; destroys the source after read
 * (success or failure) so raw transcripts do not linger on disk.
 */
export async function distillTranscripts(
  source: TranscriptSource,
  brain: Brain,
  opts?: DistillOptions
): Promise<CandidateShard[]> {
  const lines = await source.read();
  try {
    const { lines: screenedLines } = screenTranscriptLines(lines, opts);
    if (screenedLines.length === 0) {
      throw new DistillError(
        "transcript has no lines remaining after immune screening",
        "invalid_transcript"
      );
    }

    const userContent = buildUserContent(screenedLines);
    const messages = buildMessages(userContent);

    const raw = (await brain.complete(messages)).text;
    const parsed = await completeWithRetry(brain, userContent, raw);

    const lengthFiltered = filterLengthAndEmpty(parsed);
    const { shards: screenFiltered, droppedCategories } = applyImmuneScreen(lengthFiltered, opts);

    if (screenFiltered.length < MIN_SHARDS) {
      const hadScreenDrops = droppedCategories.length > 0;
      const reason = hadScreenDrops ? "screen_reject" : "too_few_shards";
      const message = hadScreenDrops
        ? `distillation produced fewer than ${String(MIN_SHARDS)} shards after immune screening`
        : `distillation produced fewer than ${String(MIN_SHARDS)} usable shards`;
      if (hadScreenDrops) {
        throw new DistillError(message, reason, { categories: droppedCategories });
      }
      throw new DistillError(message, reason);
    }

    return dedupeShards(screenFiltered).slice(0, MAX_SHARDS);
  } finally {
    // Privacy: always attempt destroy after a successful read (ENOENT-safe for files).
    await source.destroy();
  }
}
