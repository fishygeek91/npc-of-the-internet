import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/** Max visitor display-name length (code points, after cleaning). */
export const NAME_MAX = 32;
/** Max visitor message length (code points, after cleaning). */
export const TEXT_MAX = 500;

/** C0/C1 controls plus bidi embedding/override/isolate marks (spoofing). */
const NAME_STRIP_RE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** Same as {@link NAME_STRIP_RE} but keeps newline and tab in message text. */
const TEXT_STRIP_RE = /[^\P{Cc}\n\t]|[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** Names a visitor may not take (they would read as the Wanderer itself). */
const RESERVED_NAME_RE = /^(the\s+)?wanderer$/iu;

/** A validated `POST /api/say` body. */
export type VisitorSay = { name: string; text: string };

/** Result of {@link parseSay}: the cleaned message, or which field is wrong. */
export type SayParseResult =
  | { ok: true; value: VisitorSay }
  | { ok: false; code: "invalid_name" | "invalid_text"; message: string };

function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Validate and clean a visitor message body (`{ name, text }`).
 * name: control/bidi chars stripped, trimmed, 1–32 code points, not "(The) Wanderer".
 * text: CRLF → LF, control/bidi chars (except LF/TAB) stripped, trimmed, 1–500 code points.
 */
export function parseSay(body: unknown): SayParseResult {
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const rawName = record.name;
  const rawText = record.text;
  if (typeof rawName !== "string") {
    return { ok: false, code: "invalid_name", message: "name is required" };
  }
  const name = rawName.replace(NAME_STRIP_RE, "").replace(/\s+/gu, " ").trim();
  if (name.length === 0 || codePointLength(name) > NAME_MAX) {
    return {
      ok: false,
      code: "invalid_name",
      message: `name must be 1–${String(NAME_MAX)} characters`
    };
  }
  if (RESERVED_NAME_RE.test(name)) {
    return { ok: false, code: "invalid_name", message: "that name belongs to the Wanderer" };
  }
  if (typeof rawText !== "string") {
    return { ok: false, code: "invalid_text", message: "text is required" };
  }
  const text = rawText.replace(/\r\n?/gu, "\n").replace(TEXT_STRIP_RE, "").trim();
  if (text.length === 0 || codePointLength(text) > TEXT_MAX) {
    return {
      ok: false,
      code: "invalid_text",
      message: `message must be 1–${String(TEXT_MAX)} characters`
    };
  }
  return { ok: true, value: { name, text } };
}

/** `session.addressing`: the text mentions "wanderer" or starts with "@". */
export function isAddressed(text: string): boolean {
  return text.startsWith("@") || /wanderer/iu.test(text);
}

/**
 * Text relayed to the Wanderer: `@word` loses its `@` (the runtime immune screen drops
 * whole messages containing `@handle` tokens as PII). The room shows the original.
 */
export function relayText(text: string): string {
  return text.replace(/(^|\s)@(?=\w)/gu, "$1");
}

function normalizeIp(value: string): string {
  return value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

/**
 * Client IP for rate limiting: the socket peer address; only when `trustProxy` is set,
 * the LAST `X-Forwarded-For` hop (the one our own reverse proxy appended). Earlier hops
 * are visitor-controlled and ignored. Falls back to the socket address when the header is
 * missing or the hop is not an IP.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const socketIp = normalizeIp(req.socket.remoteAddress ?? "unknown");
  if (!trustProxy) {
    return socketIp;
  }
  const header = req.headers["x-forwarded-for"];
  // Repeated headers are joined in order; the last value's last hop is the proxy's.
  const joined = Array.isArray(header) ? header.join(",") : (header ?? "");
  const hops = joined
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  const last = hops[hops.length - 1];
  if (last === undefined || isIP(last) === 0) {
    return socketIp;
  }
  return normalizeIp(last);
}

/**
 * Stable per-visitor id for `author_id`: a short keyed hash of the IP under a secret
 * salt that rotates every UTC day. The raw IP never leaves this process.
 */
export class VisitorIds {
  private day = "";
  private salt: Buffer = Buffer.alloc(0);

  constructor(private readonly clock: { nowMs: () => number }) {}

  /** `web-<12 hex>` for this IP today. */
  idFor(ip: string): string {
    const today = new Date(this.clock.nowMs()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.salt = randomBytes(32);
    }
    return `web-${createHmac("sha256", this.salt).update(ip).digest("hex").slice(0, 12)}`;
  }
}
