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
 * Sanitize an untrusted display name for a single-line log label.
 * Strips separators the log format relies on and refuses names that impersonate `YOU`.
 */
export function sanitizeDisplay(raw: string | undefined): string {
  if (raw === undefined) {
    return "someone";
  }
  const cleaned = raw
    .replace(/[\r\n\t#:[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, DISPLAY_MAX)
    .trim();
  if (cleaned.length === 0 || cleaned.toUpperCase() === SELF_LABEL) {
    return "someone";
  }
  return cleaned;
}

/** Indent continuation lines so a message can never forge a `#n` log entry. */
function indentContinuations(text: string): string {
  return text.replace(/\r\n?|\n/gu, "\n    ");
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
