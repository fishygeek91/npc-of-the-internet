/**
 * Maximum Unicode code points in a memory shard (and legacy candidate) `text`.
 *
 * Normative bound in `spec/osp/records.md` (≤500). Journal markdown is not
 * capped here. Distill applies a UTF-16-unit check at this same number, which
 * is never looser than code points, so a kept shard always encodes.
 */
export const SHARD_TEXT_MAX_CODE_POINTS = 500;

/**
 * Count Unicode code points in `text` (not UTF-16 code units).
 *
 * The record schema and the side-blob encoder both use this so a string is
 * measured once, the same way.
 *
 * @param text - Prose to measure.
 * @returns The number of Unicode code points.
 */
export function countCodePoints(text: string): number {
  return [...text].length;
}
