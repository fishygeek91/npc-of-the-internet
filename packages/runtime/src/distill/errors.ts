import type { ScreenCategory } from "@npc/immune";

export type DistillErrorReason =
  "malformed_output" | "too_few_shards" | "screen_reject" | "invalid_transcript";

/** Thrown when distillation cannot produce usable candidate shards. */
export class DistillError extends Error {
  readonly code = "DISTILL_ERROR";
  readonly reason: DistillErrorReason;
  readonly categories?: readonly ScreenCategory[];

  constructor(
    message: string,
    reason: DistillErrorReason,
    options?: { categories?: readonly ScreenCategory[] }
  ) {
    super(message);
    this.name = "DistillError";
    this.reason = reason;
    const categories = options?.categories;
    if (categories !== undefined) {
      this.categories = categories;
    }
  }
}
