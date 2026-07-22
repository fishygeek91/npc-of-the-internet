import { screenText } from "@npc/immune";
import type { ScreenCategory } from "@npc/immune";
import type { Brain, BrainMessage } from "../brain/types.js";
import { DISTILLER_RETRY } from "../prompts/distiller/retry.js";
import { DISTILLER_SYSTEM } from "../prompts/distiller/system.js";
import { assignShardIds } from "../quarantine/shard-id.js";
import { DistillError } from "./errors.js";
import { countCodePoints, parseBrainShards } from "./parse.js";
import type { CandidateShard, DistillOptions, TranscriptLine, TranscriptSource } from "./types.js";

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

function toCandidateShards(shards: readonly ParsedShard[]): CandidateShard[] {
  const shardIds = assignShardIds(shards.map((shard) => shard.text));
  return shards.map((shard, index) => {
    const shardId = shardIds[index];
    if (shardId === undefined) {
      throw new DistillError("internal error: shard id assignment mismatch", "malformed_output");
    }
    const candidate: CandidateShard = {
      shard_id: shardId,
      text: shard.text
    };
    if (shard.tags !== undefined) {
      candidate.tags = shard.tags;
    }
    return candidate;
  });
}

/**
 * Distill a residency transcript into 5–20 immune-screened candidate memory shards.
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

  const clamped = screenFiltered.slice(0, MAX_SHARDS);
  const candidates = toCandidateShards(clamped);

  // T2.5: if destroy fails (e.g. EPERM), prefer returning candidates and
  // surfacing retained-transcript separately — do not force a re-distill.
  await source.destroy();
  return candidates;
}
