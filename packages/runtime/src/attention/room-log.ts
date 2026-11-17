import { normalizeScreenText } from "@npc/immune";

/** Who said a room-log line. */
export type RoomSpeaker = { kind: "human"; authorId: string; display: string } | { kind: "self" };

/** One observed message in the residency's shared room. */
export type RoomEntry = {
  /** Local, per-session reference shown to the Brain as `#<ref>`. */
  ref: number;
  /** Door protocol `msg_id` (inbound) or the Wanderer's outbound `msg_id`. */
  msgId: string;
  speaker: RoomSpeaker;
  text: string;
  /** True when the Door, a reply-to-self, or the Wanderer's name marks it as aimed at us. */
  addressed: boolean;
  /** Ref of the entry this one replies to, when known. */
  replyToRef?: number;
  channelId?: string;
};

const DISPLAY_MAX = 32;
const SELF_LABEL = "YOU";

/**
 * True when a (normalized) display name reads as the self marker: its letters alone spell
 * "you" (`YOU.`, `Y-O-U`) or its first word is "you" (`YOU (real)`). Case-insensitive.
 */
function impersonatesSelf(display: string): boolean {
  const words = display
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 0);
  const marker = SELF_LABEL.toLowerCase();
  return words[0] === marker || words.join("") === marker;
}

/** Zero-width (non-)joiner: kept only inside emoji / complex-script sequences. */
const JOINER_PATTERN = /^[\u200C\u200D]$/u;
/** Non-ASCII letter, mark, pictograph, or skin-tone modifier a joiner may connect. */
const JOINABLE_PATTERN = /^[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}]$/u;
/** Invisible format characters (bidi controls, ZWSP, tags, …) — removed outright. */
const FORMAT_PATTERN = /^\p{Cf}$/u;
/**
 * Turned into a space: controls, line/paragraph separators, blank-looking fillers
 * (Hangul fillers, braille blank), and the separators the log format relies on.
 */
const SPACE_LIKE_PATTERN = /^[\p{Cc}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800#:[\]]$/u;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isJoinable(char: string | undefined): boolean {
  return char !== undefined && (char.codePointAt(0) ?? 0) > 0x7f && JOINABLE_PATTERN.test(char);
}

/**
 * Display view of an untrusted name: NFKC, format characters removed (ZWJ/ZWNJ kept only
 * between non-ASCII letters/marks/pictographs, so family emoji and Indic conjuncts stay
 * intact while `Y\u200DOU`-style smuggling is dropped), control / separator / blank
 * characters → space. Unlike the immune screen's matching normalizer it is not lossy:
 * `José`, `Дмитрий`, `प्रिया` survive as written.
 */
function displayView(raw: string): string {
  const chars = Array.from(raw.normalize("NFKC"));
  let out = "";
  let prevKept: string | undefined;
  chars.forEach((char, index) => {
    let piece: string;
    if (JOINER_PATTERN.test(char)) {
      piece = isJoinable(prevKept) && isJoinable(chars[index + 1]) ? char : "";
    } else if (SPACE_LIKE_PATTERN.test(char)) {
      piece = " ";
    } else if (FORMAT_PATTERN.test(char)) {
      piece = "";
    } else {
      piece = char;
    }
    if (piece.length > 0) {
      out += piece;
      prevKept = piece;
    }
  });
  return out;
}

/** Cut to at most `max` UTF-16 units without splitting a grapheme cluster. */
function truncateGraphemes(text: string, max: number): string {
  let out = "";
  for (const { segment } of graphemes.segment(text)) {
    if (out.length + segment.length > max) {
      break;
    }
    out += segment;
  }
  return out;
}

/**
 * Sanitize an untrusted display name for a single-line log label (it reaches the LLM
 * prompt, so it must stay faithful to what people actually called themselves).
 * NFKC-normalizes, drops invisible format characters, turns control/line-separator
 * characters and the separators the log format relies on into spaces, and truncates on a
 * grapheme boundary. Names that impersonate `YOU` are refused using the immune screen's
 * lossy matching view (fullwidth `ＹＯＵ`, Cyrillic/Greek homoglyphs, zero-width splits),
 * which is used **only** for that check — never for the displayed text.
 */
export function sanitizeDisplay(raw: string | undefined): string {
  if (raw === undefined) {
    return "someone";
  }
  const cleaned = truncateGraphemes(
    displayView(raw).replace(/\s+/gu, " ").trim(),
    DISPLAY_MAX
  ).trim();
  if (
    cleaned.length === 0 ||
    impersonatesSelf(normalizeScreenText(cleaned)) ||
    impersonatesSelf(normalizeScreenText(displayView(raw)))
  ) {
    return "someone";
  }
  return cleaned;
}

/**
 * Indent continuation lines so a message can never forge a `#n` log entry. Every Unicode
 * line break (incl. VT/FF/NEL/LS/PS, which some tokenizers render as newlines) counts.
 */
function indentContinuations(text: string): string {
  return text.replace(/\r\n?|[\n\v\f\u0085\u2028\u2029]/gu, "\n    ");
}

/**
 * Bounded, in-memory log of the room as the Wanderer perceives it: every screened
 * human message plus everything it said. Rendered into the attention prompt.
 * Never persisted (lives and dies with the Session).
 */
export class RoomLog {
  private readonly entries: RoomEntry[] = [];
  private readonly byMsgId = new Map<string, RoomEntry>();
  private nextRef = 1;
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** Record a human message; resolves `replyToMsgId` against known entries. */
  addHuman(args: {
    msgId: string;
    authorId: string;
    authorDisplay?: string;
    text: string;
    addressed: boolean;
    replyToMsgId?: string;
    channelId?: string;
  }): RoomEntry {
    const parent =
      args.replyToMsgId === undefined ? undefined : this.byMsgId.get(args.replyToMsgId);
    const entry: RoomEntry = {
      ref: this.nextRef,
      msgId: args.msgId,
      speaker: {
        kind: "human",
        authorId: args.authorId,
        display: sanitizeDisplay(args.authorDisplay)
      },
      text: args.text,
      addressed: args.addressed,
      ...(parent === undefined ? {} : { replyToRef: parent.ref }),
      ...(args.channelId === undefined ? {} : { channelId: args.channelId })
    };
    this.push(entry);
    return entry;
  }

  /** Record something the Wanderer said. */
  addSelf(args: { msgId: string; text: string; replyToRef?: number }): RoomEntry {
    const entry: RoomEntry = {
      ref: this.nextRef,
      msgId: args.msgId,
      speaker: { kind: "self" },
      text: args.text,
      addressed: false,
      ...(args.replyToRef === undefined ? {} : { replyToRef: args.replyToRef })
    };
    this.push(entry);
    return entry;
  }

  /** Look up an entry by protocol `msg_id`. */
  getByMsgId(msgId: string): RoomEntry | undefined {
    return this.byMsgId.get(msgId);
  }

  /** Resolve a Brain-supplied `#<n>` (or bare `<n>`) reference to a live entry. */
  resolveRef(ref: string | null | undefined): RoomEntry | undefined {
    if (ref === null || ref === undefined) {
      return undefined;
    }
    const match = /^\s*#?(\d+)\s*$/u.exec(ref);
    if (match === null || match[1] === undefined) {
      return undefined;
    }
    const n = Number.parseInt(match[1], 10);
    return this.entries.find((entry) => entry.ref === n);
  }

  /** True when `msgId` is one of the Wanderer's own messages. */
  isSelfMessage(msgId: string | undefined): boolean {
    if (msgId === undefined) {
      return false;
    }
    return this.byMsgId.get(msgId)?.speaker.kind === "self";
  }

  /** Fraction of the last `window` entries that the Wanderer said (0 when empty). */
  selfShare(window: number): number {
    const recent = this.entries.slice(-Math.max(1, window));
    if (recent.length === 0) {
      return 0;
    }
    const mine = recent.filter((entry) => entry.speaker.kind === "self").length;
    return mine / recent.length;
  }

  /** Render the log for the attention prompt, oldest first. */
  render(): string {
    return this.entries.map(renderEntry).join("\n");
  }

  private push(entry: RoomEntry): void {
    this.nextRef += 1;
    this.entries.push(entry);
    this.byMsgId.set(entry.msgId, entry);
    while (this.entries.length > this.maxEntries) {
      const dropped = this.entries.shift();
      if (dropped !== undefined) {
        this.byMsgId.delete(dropped.msgId);
      }
    }
  }
}

function renderEntry(entry: RoomEntry): string {
  const who = entry.speaker.kind === "self" ? SELF_LABEL : entry.speaker.display;
  const reply = entry.replyToRef === undefined ? "" : ` (↩ #${String(entry.replyToRef)})`;
  const addressed = entry.addressed ? " [ADDRESSED]" : "";
  return `#${String(entry.ref)} ${who}${reply}${addressed}: ${indentContinuations(entry.text)}`;
}
