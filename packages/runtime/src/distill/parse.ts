import { z } from "zod";

import { DistillError } from "./errors.js";

const BrainShardSchema = z
  .object({
    text: z.string(),
    tags: z.array(z.string()).optional()
  })
  .strict();

const BrainShardsSchema = z
  .object({
    shards: z.array(BrainShardSchema)
  })
  .strict();

/** Count Unicode code points (not UTF-16 code units). */
export function countCodePoints(text: string): number {
  return [...text].length;
}

/** Strip optional markdown code fences wrapping JSON. */
function stripMarkdownFences(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "");
  } else {
    trimmed = trimmed.slice(firstNewline + 1);
  }

  if (trimmed.endsWith("```")) {
    trimmed = trimmed.slice(0, -3).trimEnd();
  }

  return trimmed.trim();
}

/**
 * Parse and validate Brain distiller JSON output.
 *
 * @returns Shard bodies without `shard_id`; `tags` omitted when absent.
 */
export function parseBrainShards(raw: string): { text: string; tags?: string[] }[] {
  const stripped = stripMarkdownFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new DistillError("distiller output is not valid JSON", "malformed_output");
  }

  const result = BrainShardsSchema.safeParse(parsed);
  if (!result.success) {
    throw new DistillError(
      "distiller output does not match the required shard schema",
      "malformed_output"
    );
  }

  return result.data.shards.map((shard) => {
    const entry: { text: string; tags?: string[] } = { text: shard.text };
    if (shard.tags !== undefined) {
      entry.tags = shard.tags;
    }
    return entry;
  });
}
