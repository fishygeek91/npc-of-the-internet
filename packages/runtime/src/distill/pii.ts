import type { PiiCategory } from "./types.js";

/** Standard-ish email local@domain pattern. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Digit groups with separators typical of phone numbers (7+ digits total).
 * Known false-positive without filtering: ISO dates and year ranges (see
 * {@link isDateLikePhoneFalsePositive}); T3.1 should inherit that exclusion.
 */
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/g;

/** @handle tokens preceded by start-of-string or whitespace. */
const HANDLE_PATTERN = /(?:^|\s)(@[A-Za-z0-9_]{2,})/g;

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

function screenCategory(
  text: string,
  pattern: RegExp,
  category: PiiCategory,
  allowlist: readonly string[] | undefined,
  ignoreSpan?: (span: string) => boolean
): { ok: true } | { ok: false; category: PiiCategory } {
  const matches = collectMatches(text, pattern).filter(
    (span) => ignoreSpan === undefined || !ignoreSpan(span)
  );
  if (matches.length === 0) {
    return { ok: true };
  }
  const allAllowlisted = matches.every((span) => isAllowlisted(span, allowlist));
  if (allAllowlisted) {
    return { ok: true };
  }
  return { ok: false, category };
}

// T3.1: immune screen hook
/**
 * Static PII screen for distiller shard text.
 * Replaced by the immune package static screen in T3.1.
 */
export function screenPii(
  text: string,
  allowlist?: readonly string[]
): { ok: true } | { ok: false; category: PiiCategory } {
  const emailResult = screenCategory(text, EMAIL_PATTERN, "email", allowlist);
  if (!emailResult.ok) {
    return emailResult;
  }

  const phoneResult = screenCategory(
    text,
    PHONE_PATTERN,
    "phone",
    allowlist,
    isDateLikePhoneFalsePositive
  );
  if (!phoneResult.ok) {
    return phoneResult;
  }

  const handleResult = screenCategory(text, HANDLE_PATTERN, "handle", allowlist);
  if (!handleResult.ok) {
    return handleResult;
  }

  return { ok: true };
}
