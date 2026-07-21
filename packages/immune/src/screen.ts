import { collectInjectionCategories } from "./injection.js";
import { collectPiiCategories } from "./pii.js";
import type { ScreenCategory, ScreenOptions, ScreenResult } from "./types.js";

const CATEGORY_ORDER: readonly ScreenCategory[] = [
  "pii.email",
  "pii.phone",
  "pii.handle",
  "injection.instruction",
  "injection.role_marker",
  "injection.url_payload"
];

function orderCategories(found: readonly ScreenCategory[]): ScreenCategory[] {
  const foundSet = new Set(found);
  return CATEGORY_ORDER.filter((category) => foundSet.has(category));
}

/**
 * Synchronous static screen for untrusted text (PII + injection heuristics).
 * Pure: no I/O, time, randomness, or logging. Results and errors carry categories only.
 */
export function screenText(text: string, opts?: ScreenOptions): ScreenResult {
  const allowlist = opts?.allowlist;
  const piiCategories = collectPiiCategories(text, allowlist);
  const injectionCategories = collectInjectionCategories(text);
  const categories = orderCategories([...piiCategories, ...injectionCategories]);

  if (categories.length === 0) {
    return { ok: true };
  }

  return { ok: false, categories };
}
