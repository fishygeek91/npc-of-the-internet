import type { ScreenCategory } from "./types.js";

/** Imperative override phrasing (case-insensitive). */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
  /\bdisregard\s+your\s+(?:rules|instructions|charter)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions\s*:/i,
  /\bsystem\s+prompt\b/i
];

/** Chat role prefixes at line start only — not mid-sentence "the system: …". */
const ROLE_LINE_START_PATTERN = /^\s*(?:system|assistant|user):\s*/im;

/** ChatML / Llama-style role markers. */
const IM_START_PATTERN = /<\|im_start\|>/;

/** Instruction-tuned model bracket tokens. */
const INST_PATTERN = /\[INST\]/;

/** XML-style role tags such as `<system>` or `<assistant>`. */
const ROLE_TAG_PATTERN = /<(?:system|assistant|user)(?:\s|>|\/)/i;

/** `data:` URIs carrying inline payloads. */
const DATA_URI_PATTERN = /\bdata:[^\s]+/i;

/** HTTP(S) URLs with a long base64-alphabet run in query or fragment. */
const URL_BASE64_PAYLOAD_PATTERN = /https?:\/\/\S+[?#]\S*[A-Za-z0-9+/=_-]{40,}/i;

/**
 * HTTP(S) URLs embedding instruction-like phrases.
 * Known v0.1 FP: docs paths containing "instructions" (e.g. `/setup-instructions`).
 * Measure and tighten when T7.4 verifier ensemble lands.
 */
const URL_INSTRUCTION_PATTERN =
  /https?:\/\/\S*(?:ignore|disregard|instructions|system[\s_%+-]*prompt)/i;

/** Long base64-alphabet runs outside URL spans (evasion payloads pasted inline). */
const BARE_BASE64_RUN_PATTERN = /[A-Za-z0-9+/_-]{40,}(?:=+)?/g;

/** HTTP(S) URL spans excluded from bare-base64 detection. */
const HTTP_URL_SPAN_PATTERN = /https?:\/\/\S+/gi;

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

type TextSpan = { start: number; end: number };

function collectUrlSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];

  const httpPattern = new RegExp(HTTP_URL_SPAN_PATTERN.source, HTTP_URL_SPAN_PATTERN.flags);
  let httpMatch: RegExpExecArray | null = httpPattern.exec(text);
  while (httpMatch !== null) {
    spans.push({ start: httpMatch.index, end: httpMatch.index + httpMatch[0].length });
    httpMatch = httpPattern.exec(text);
  }

  const dataPattern = new RegExp(DATA_URI_PATTERN.source, `${DATA_URI_PATTERN.flags}g`);
  let dataMatch: RegExpExecArray | null = dataPattern.exec(text);
  while (dataMatch !== null) {
    spans.push({ start: dataMatch.index, end: dataMatch.index + dataMatch[0].length });
    dataMatch = dataPattern.exec(text);
  }

  return spans;
}

function overlapsSpan(candidate: TextSpan, spans: readonly TextSpan[]): boolean {
  return spans.some((span) => candidate.start < span.end && candidate.end > span.start);
}

function hasBareLongBase64OutsideUrls(text: string): boolean {
  const urlSpans = collectUrlSpans(text);
  const barePattern = new RegExp(BARE_BASE64_RUN_PATTERN.source, BARE_BASE64_RUN_PATTERN.flags);
  let match: RegExpExecArray | null = barePattern.exec(text);
  while (match !== null) {
    const candidate: TextSpan = {
      start: match.index,
      end: match.index + match[0].length
    };
    if (!overlapsSpan(candidate, urlSpans)) {
      return true;
    }
    match = barePattern.exec(text);
  }
  return false;
}

/**
 * Collect injection categories present in `text`.
 * Returns unique categories in stable order: instruction, role_marker, url_payload.
 */
export function collectInjectionCategories(text: string): ScreenCategory[] {
  const categories: ScreenCategory[] = [];

  if (matchesAny(text, INSTRUCTION_PATTERNS)) {
    categories.push("injection.instruction");
  }

  if (
    ROLE_LINE_START_PATTERN.test(text) ||
    IM_START_PATTERN.test(text) ||
    INST_PATTERN.test(text) ||
    ROLE_TAG_PATTERN.test(text)
  ) {
    categories.push("injection.role_marker");
  }

  if (
    DATA_URI_PATTERN.test(text) ||
    URL_BASE64_PAYLOAD_PATTERN.test(text) ||
    URL_INSTRUCTION_PATTERN.test(text) ||
    hasBareLongBase64OutsideUrls(text)
  ) {
    categories.push("injection.url_payload");
  }

  return categories;
}
