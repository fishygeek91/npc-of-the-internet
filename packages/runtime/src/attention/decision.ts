import { OutboundReactionSchema } from "@npc/door-sdk";
import { z } from "zod";

import type { RoomEntry, RoomLog } from "./room-log.js";

/** Max spoken characters per outbound frame (door/0.1 limit). */
export const MAX_SAY_CHARS = 4000;

/** Name the Wanderer answers to in the room (charter: "the Wanderer"). */
const NAME_PATTERN = /\bwanderer\b/iu;

const RawDecisionSchema = z.object({
  say: z.string().nullable().optional(),
  reply_to: z.union([z.string(), z.number()]).nullable().optional(),
  react: z
    .object({
      emoji: z.string(),
      to: z.union([z.string(), z.number()])
    })
    .nullable()
    .optional()
});

/** Brain output after lenient JSON extraction and shape validation. */
export type RawAttentionDecision = z.infer<typeof RawDecisionSchema>;

/** Selective-attention tuning. */
export type AttentionPolicy = {
  /** Door advertised `session.reactions`. */
  reactions: boolean;
  /**
   * Floor guard: when not addressed, the Wanderer may not speak if it already said at
   * least this fraction of the last `shareWindow` room messages. Reactions still allowed.
   */
  maxSelfShare: number;
  shareWindow: number;
  /**
   * Optional token cap for one attention decision. Unset = the Brain's configured default
   * (`NPC_BRAIN_MAX_TOKENS`), which leaves headroom for models that think before answering.
   */
  maxTokens?: number;
};

export const DEFAULT_ATTENTION_POLICY: AttentionPolicy = {
  reactions: false,
  maxSelfShare: 0.3,
  shareWindow: 9
};

/** A decision resolved against the room log and policy. */
export type ResolvedAttention = {
  say: string | null;
  replyTo: RoomEntry | undefined;
  react: { emoji: string; target: RoomEntry } | undefined;
  /** Why the result is silent / reduced, for ops logs. */
  notes: AttentionNote[];
};

export type AttentionNote =
  | "unparseable"
  | "unparseable_fallback_speech"
  | "floor_guard"
  | "reaction_invalid"
  | "reaction_unsupported"
  | "reply_ref_unknown";

/**
 * True when a newly observed entry is aimed at the Wanderer: Door flag, a reply to one of
 * its messages, or its name in the text.
 */
export function isAddressed(args: {
  doorAddressed: boolean | undefined;
  repliesToSelf: boolean;
  text: string;
}): boolean {
  return args.doorAddressed === true || args.repliesToSelf || NAME_PATTERN.test(args.text);
}

/** Tag names reasoning models use to wrap their private chain of thought. */
const REASONING_TAGS = "think|thinking|reasoning|reflection";
/** Open (`<think …>`, or a truncated `<think`) or close (`</think>`) reasoning tag. */
const REASONING_TAG_PATTERN = new RegExp(`<(\\/)?\\s*(${REASONING_TAGS})\\b[^>]*>?`, "giu");
const REASONING_MARKER_PATTERN = new RegExp(`<\\/?\\s*(?:${REASONING_TAGS})\\b`, "iu");

/**
 * Remove model reasoning (`<think>…</think>` and similar) from Brain output. A dangling
 * close tag (provider stripped the opener) drops everything before it; an unclosed open
 * tag (reasoning truncated by the token cap) drops everything after it.
 *
 * Tags inside a balanced top-level `{…}` object (e.g. the decision's own
 * `{"say":"try <think> tags"}`) are content, not reasoning markers, and are ignored —
 * otherwise an unclosed tag in a JSON string would erase the whole answer.
 */
export function stripReasoning(raw: string): string {
  const spans = topLevelObjectSpans(raw);
  const insideObject = (index: number): boolean =>
    spans.some(([start, end]) => index > start && index <= end);

  const removals: Array<[number, number]> = [];
  let open: { start: number; name: string } | null = null;
  for (const match of raw.matchAll(REASONING_TAG_PATTERN)) {
    if (insideObject(match.index)) {
      continue;
    }
    const name = (match[2] ?? "").toLowerCase();
    const end = match.index + match[0].length;
    if (match[1] === undefined) {
      // Nested opens inside an open block are part of that block.
      open ??= { start: match.index, name };
      continue;
    }
    if (open !== null && open.name === name) {
      removals.push([open.start, end]);
    } else {
      // Dangling close: everything before it was reasoning.
      removals.push([0, end]);
    }
    open = null;
  }
  if (open !== null) {
    removals.push([open.start, raw.length]);
  }

  // Merge overlapping ranges, then keep what lies between them.
  removals.sort((a, b) => a[0] - b[0]);
  const kept: string[] = [];
  let cursor = 0;
  for (const [start, end] of removals) {
    if (start > cursor) {
      kept.push(raw.slice(cursor, start));
    }
    cursor = Math.max(cursor, end);
  }
  kept.push(raw.slice(cursor));
  return kept.join(" ");
}

/**
 * Spans `[start, end]` of balanced `{…}` groups that are not nested inside another
 * balanced group, in source order. String-aware inside braces so `}` in JSON strings
 * does not close a group; a stray unclosed `{` in prose does not hide later objects.
 */
function topLevelObjectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const opens: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"' && opens.length > 0) {
      inString = true;
    } else if (ch === "{") {
      opens.push(i);
    } else if (ch === "}") {
      const start = opens.pop();
      if (start !== undefined) {
        // Drop spans this one encloses; what remains is maximal.
        while (spans.length > 0 && (spans[spans.length - 1]?.[0] ?? -1) > start) {
          spans.pop();
        }
        spans.push([start, i]);
      }
    }
  }
  return spans;
}

/**
 * Leniently extract a decision from Brain text (tolerates reasoning blocks, code fences and
 * prose around it): strips reasoning, then takes the **last** top-level JSON object that
 * parses and matches the decision shape. Returns `null` when none does.
 */
export function parseAttentionDecision(raw: string): RawAttentionDecision | null {
  const cleaned = stripReasoning(raw);
  const spans = topLevelObjectSpans(cleaned);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (span === undefined) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(cleaned.slice(span[0], span[1] + 1));
    } catch {
      continue;
    }
    const parsed = RawDecisionSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}

function refString(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? String(value) : value;
}

/**
 * Turn Brain output into an executable decision: resolve `#n` refs, validate the emoji,
 * and apply the floor guard. Unparseable output becomes silence unless the batch
 * addressed the Wanderer and the text (reasoning stripped) is plain prose with no `{`
 * (then it is spoken as-is).
 */
export function resolveAttention(args: {
  raw: string;
  log: RoomLog;
  policy: AttentionPolicy;
  addressed: boolean;
  /** Self share measured before this decision (so the guard ignores the new batch's own line). */
  selfShare: number;
}): ResolvedAttention {
  const notes: AttentionNote[] = [];
  const decision = parseAttentionDecision(args.raw);

  if (decision === null) {
    // Speak plain prose only: never anything that looks like (broken) JSON, a code fence,
    // or model reasoning — those would leak the decision machinery into the room.
    const prose = stripReasoning(args.raw).trim();
    if (
      args.addressed &&
      prose.length > 0 &&
      !prose.includes("{") &&
      !prose.startsWith("`") &&
      !REASONING_MARKER_PATTERN.test(prose)
    ) {
      notes.push("unparseable_fallback_speech");
      return { say: prose.slice(0, MAX_SAY_CHARS), replyTo: undefined, react: undefined, notes };
    }
    notes.push("unparseable");
    return { say: null, replyTo: undefined, react: undefined, notes };
  }

  const sayRaw = decision.say?.trim() ?? "";
  let say: string | null = sayRaw.length === 0 ? null : sayRaw.slice(0, MAX_SAY_CHARS);

  const replyRef = refString(decision.reply_to);
  let replyTo = args.log.resolveRef(replyRef);
  if (replyRef !== undefined && replyTo === undefined) {
    notes.push("reply_ref_unknown");
  }

  let react: ResolvedAttention["react"];
  if (decision.react !== null && decision.react !== undefined) {
    const target = args.log.resolveRef(refString(decision.react.to));
    const emoji = decision.react.emoji.trim();
    if (!args.policy.reactions) {
      notes.push("reaction_unsupported");
    } else if (
      target === undefined ||
      target.speaker.kind === "self" ||
      !OutboundReactionSchema.safeParse({ emoji, target_msg_id: target.msgId }).success
    ) {
      notes.push("reaction_invalid");
    } else {
      react = { emoji, target };
    }
  }

  if (say !== null && !args.addressed && args.selfShare >= args.policy.maxSelfShare) {
    notes.push("floor_guard");
    say = null;
  }
  if (say === null) {
    replyTo = undefined;
  }

  return { say, replyTo, react, notes };
}
