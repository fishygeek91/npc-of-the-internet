import type { Brain, BrainMessage } from "../brain/types.js";
import { DISTILLER_RETRY } from "../prompts/distiller/retry.js";
import { DISTILLER_SYSTEM } from "../prompts/distiller/system.js";
import { DistillError } from "./errors.js";
import { countCodePoints, parseBrainShards } from "./parse.js";
import { screenPii } from "./pii.js";
import type {
  CandidateShard,
  DistillOptions,
  PiiCategory,
  TranscriptLine,
  TranscriptSource
} from "./types.js";

const MIN_SHARDS = 5;
const MAX_SHARDS = 20;
const MAX_SHARD_CODE_POINTS = 500;

type ParsedShard = { text: string; tags?: string[] };

function formatTranscriptLine(line: TranscriptLine): string {
  const authorSuffix = line.author_id !== undefined ? ` (${line.author_id})` : "";
  return `[${line.role}]${authorSuffix}: ${line.text}`;
}

function buildUserContent(lines: readonly TranscriptLine[]): string {
  const body = lines.map(formatTranscriptLine).join("\n");
  return `${body}\n\nDistill this residency into memory shards. Respond with JSON only.`;
}

function buildMessages(userContent: string): BrainMessage[] {
  return [
    { role: "system", content: DISTILLER_SYSTEM },
    { role: "user", content: userContent }
  ];
}

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

    const retryUserContent = DISTILLER_RETRY.replaceAll("{{error}}", error.message);
    const retryMessages: BrainMessage[] = [
      { role: "system", content: DISTILLER_SYSTEM },
      { role: "user", content: userContent },
      { role: "assistant", content: initialRaw },
      { role: "user", content: retryUserContent }
    ];

    const retryRaw = await brain.complete(retryMessages);
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

function filterLengthAndEmpty(shards: readonly ParsedShard[]): ParsedShard[] {
  const usable: ParsedShard[] = [];
  for (const shard of shards) {
    if (shard.text.trim().length === 0) {
      continue;
    }
    if (countCodePoints(shard.text) > MAX_SHARD_CODE_POINTS) {
      continue;
    }
    usable.push(shard);
  }
  return usable;
}

function applyPiiScreen(
  shards: readonly ParsedShard[],
  opts: DistillOptions | undefined
): { shards: ParsedShard[]; droppedCategories: PiiCategory[] } {
  const allowlist = opts?.piiAllowlist;
  const onPiiReject = opts?.onPiiReject;
  const kept: ParsedShard[] = [];
  const droppedCategories: PiiCategory[] = [];

  for (const shard of shards) {
    // T3.1: immune screen hook
    const screenResult = screenPii(shard.text, allowlist);
    if (!screenResult.ok) {
      onPiiReject?.(screenResult.category);
      if (!droppedCategories.includes(screenResult.category)) {
        droppedCategories.push(screenResult.category);
      }
      continue;
    }
    kept.push(shard);
  }

  return { shards: kept, droppedCategories };
}

function toCandidateShards(shards: readonly ParsedShard[]): CandidateShard[] {
  return shards.map((shard, index) => {
    const candidate: CandidateShard = {
      shard_id: `shard-${String(index + 1)}`,
      text: shard.text
    };
    if (shard.tags !== undefined) {
      candidate.tags = shard.tags;
    }
    return candidate;
  });
}

/**
 * Distill a residency transcript into 5–20 PII-screened candidate memory shards.
 * Destroys the transcript source after a successful run.
 */
export async function distillTranscripts(
  source: TranscriptSource,
  brain: Brain,
  opts?: DistillOptions
): Promise<CandidateShard[]> {
  const lines = await source.read();
  const userContent = buildUserContent(lines);
  const messages = buildMessages(userContent);

  const raw = await brain.complete(messages);
  const parsed = await completeWithRetry(brain, userContent, raw);

  const lengthFiltered = filterLengthAndEmpty(parsed);
  const { shards: piiFiltered, droppedCategories } = applyPiiScreen(lengthFiltered, opts);

  if (piiFiltered.length < MIN_SHARDS) {
    const hadPiiDrops = droppedCategories.length > 0;
    const reason = hadPiiDrops ? "pii_screen" : "too_few_shards";
    const message = hadPiiDrops
      ? `distillation produced fewer than ${String(MIN_SHARDS)} shards after PII screening`
      : `distillation produced fewer than ${String(MIN_SHARDS)} usable shards`;
    if (hadPiiDrops) {
      throw new DistillError(message, reason, { categories: droppedCategories });
    }
    throw new DistillError(message, reason);
  }

  const clamped = piiFiltered.slice(0, MAX_SHARDS);
  const candidates = toCandidateShards(clamped);

  await source.destroy();
  return candidates;
}
