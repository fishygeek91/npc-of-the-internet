import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/** Max visitor display-name length (code points, after cleaning). */
export const NAME_MAX = 32;
/** Max visitor message length (code points, after cleaning). */
export const TEXT_MAX = 500;

/**
 * Controls (`Cc`), invisible format characters (`Cf`: zero-width space/joiners, bidi
 * marks and overrides, soft hyphen, Unicode tag characters) and other default-ignorable
 * code points (Hangul fillers, variation selectors, …) — spoofing and hidden text.
 */
const NAME_STRIP_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * Same as {@link NAME_STRIP_RE} for message text, except newline and tab are kept, and so
 * are the zero-width joiner (U+200D) and variation selectors so emoji like 👩‍💻 and ❤️
 * survive.
 */
const TEXT_STRIP_RE =
  /[^\P{Cc}\n\t]|[^\P{Cf}\u200D]|(?![\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]|\u200D)\p{Default_Ignorable_Code_Point}/gu;
/** Folded names a visitor may not take (they would read as the Wanderer itself). */
const RESERVED_FOLDED_NAMES: ReadonlySet<string> = new Set(["wanderer", "thewanderer"]);

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
 * Comparison form of a display name: NFKC, default-ignorables dropped, lowercase, letters
 * only — so "THE  WANDERER", "the wanderer.", full-width "Ｗａｎｄｅｒｅｒ" and
 * "Wㅤanderer" (Hangul filler) all fold to the same key.
 */
export function foldName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(NAME_STRIP_RE, "")
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "");
}

/** True when `name` would read as the Wanderer itself ("(The) Wanderer" in any disguise). */
export function isReservedName(name: string): boolean {
  return RESERVED_FOLDED_NAMES.has(foldName(name.replace(NAME_STRIP_RE, "")));
}

/**
 * Validate and clean a visitor message body (`{ name, text }`).
 * name: control, format (`Cf`) and default-ignorable chars stripped, whitespace collapsed,
 * trimmed, 1–32 code points, and not "(The) Wanderer" after folding ({@link foldName}).
 * text: CRLF → LF, control, format and default-ignorable chars (except LF, TAB, ZWJ and
 * variation selectors) stripped, trimmed, 1–500 code points.
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
  if (isReservedName(name)) {
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

/** Parse an IPv6 address (no zone) into eight 16-bit groups; `null` when malformed. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const dotted = text.slice(lastColon + 1);
  if (isIP(dotted) === 4) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split(".").map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, lastColon);
    if (text.endsWith(":")) {
      text += ":"; // the dotted quad followed "::"
    }
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const width = 8 - tail.length;
  const missing = width - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const hex = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...rest];
  const groups = hex.map((group) => (/^[0-9a-f]{1,4}$/iu.test(group) ? parseInt(group, 16) : NaN));
  if (groups.some((group) => Number.isNaN(group))) {
    return null;
  }
  return [...groups, ...tail];
}

/**
 * Rate-limit / connection-cap key for a client address. IPv4 is used as is; an IPv6 host
 * is keyed by its /64 prefix (one subscriber usually owns a whole /64 and can rotate
 * through it freely), and IPv4-mapped IPv6 (`::ffff:a.b.c.d`, any spelling) by its IPv4.
 */
export function clientKey(ip: string): string {
  const bare = ip.split("%")[0] ?? ip;
  if (isIP(bare) !== 6) {
    return ip;
  }
  const groups = ipv6Groups(bare);
  if (groups === null) {
    return ip;
  }
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${String(g6 >> 8)}.${String(g6 & 0xff)}.${String(g7 >> 8)}.${String(g7 & 0xff)}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
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
