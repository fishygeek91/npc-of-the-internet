import type { ScreenCategory } from "./types.js";

/** Standard-ish email local@domain pattern. */
export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Digit groups with separators typical of phone numbers (7+ digits total).
 * Known false-positive without filtering: ISO dates and year ranges (see
 * {@link isDateLikePhoneFalsePositive}).
 */
export const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/g;

/** @handle tokens preceded by start-of-string or whitespace. */
export const HANDLE_PATTERN = /(?:^|\s)(@[A-Za-z0-9_]{2,})/g;

/** ISO `YYYY-MM-DD` or four-digit year range `YYYY-YYYY` — not phone numbers. */
function isDateLikePhoneFalsePositive(span: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(span) || /^\d{4}-\d{4}$/.test(span);
}

function collectMatches(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  );
  let match: RegExpExecArray | null = globalPattern.exec(text);
  while (match !== null) {
    const span = match[1] ?? match[0];
    matches.push(span.trim());
    match = globalPattern.exec(text);
  }
  return matches;
}

function isAllowlisted(span: string, allowlist: readonly string[] | undefined): boolean {
  if (allowlist === undefined || allowlist.length === 0) {
    return false;
  }
  return allowlist.some((entry) => entry === span);
}

function categorySuppressed(
  text: string,
  pattern: RegExp,
  allowlist: readonly string[] | undefined,
  ignoreSpan?: (span: string) => boolean
): boolean {
  const matches = collectMatches(text, pattern).filter(
    (span) => ignoreSpan === undefined || !ignoreSpan(span)
  );
  if (matches.length === 0) {
    return true;
  }
  return matches.every((span) => isAllowlisted(span, allowlist));
}

/**
 * Collect all PII categories present in `text`.
 * A category is omitted only when every match in that category is allowlisted.
 */
export function collectPiiCategories(
  text: string,
  allowlist?: readonly string[]
): ScreenCategory[] {
  const categories: ScreenCategory[] = [];

  if (!categorySuppressed(text, EMAIL_PATTERN, allowlist)) {
    categories.push("pii.email");
  }

  if (!categorySuppressed(text, PHONE_PATTERN, allowlist, isDateLikePhoneFalsePositive)) {
    categories.push("pii.phone");
  }

  if (!categorySuppressed(text, HANDLE_PATTERN, allowlist)) {
    categories.push("pii.handle");
  }

  return categories;
}
