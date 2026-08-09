/** Unicode format characters (category Cf) stripped before screening. */
const FORMAT_CHAR_PATTERN = /\p{Cf}/gu;

/**
 * Normalize untrusted text before static screening.
 * Applies NFKC normalization and removes invisible format characters that can
 * evade regex heuristics (e.g. zero-width joiners inside instruction phrases).
 */
export function normalizeScreenText(text: string): string {
  return text.normalize("NFKC").replace(FORMAT_CHAR_PATTERN, "");
}
