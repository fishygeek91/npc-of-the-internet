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

/**
 * Leniently extract one JSON object from Brain text (tolerates code fences / prose around it).
 * Returns `null` when no valid decision object is present.
 */
export function parseAttentionDecision(raw: string): RawAttentionDecision | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = RawDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
 * addressed the Wanderer and the text is plain prose (then it is spoken as-is).
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
    const prose = args.raw.trim();
    if (args.addressed && prose.length > 0 && !prose.startsWith("{") && !prose.startsWith("`")) {
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
