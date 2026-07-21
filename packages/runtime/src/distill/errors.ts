import type { PiiCategory } from "./types.js";

export type DistillErrorReason =
  "malformed_output" | "too_few_shards" | "pii_screen" | "invalid_transcript";

/** Thrown when distillation cannot produce usable candidate shards. */
export class DistillError extends Error {
  readonly code = "DISTILL_ERROR";
  readonly reason: DistillErrorReason;
  readonly categories?: readonly PiiCategory[];

  constructor(
    message: string,
    reason: DistillErrorReason,
    options?: { categories?: readonly PiiCategory[] }
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
