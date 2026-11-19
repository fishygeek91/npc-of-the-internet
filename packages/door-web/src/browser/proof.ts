import { z } from "zod";

/**
 * Informational shape of an unsigned outbound frame (`spec/door/web.md`).
 * `canonicalize` of the original object is what `sig` covers, including fields
 * this type does not name. Not a parser: {@link OutboundProofSchema} and
 * {@link readProof} are the boundary for untrusted input.
 */
export type OutboundSigned = {
  type: "outbound";
  door_id: string;
  epoch: number;
  msg_id: string;
  issued_at: string;
  body: {
    text?: string | undefined;
    reply_to?: string | undefined;
    channel_id?: string | undefined;
    reaction?: { emoji: string; target_msg_id: string } | undefined;
  };
};

/**
 * Informational shape of a session-key signature over {@link OutboundSigned}.
 * Not a parser: {@link OutboundProofSchema} and {@link readProof} are the
 * boundary for untrusted input.
 */
export type OutboundProof = {
  signed: OutboundSigned;
  sig: string;
};

const reactionSchema = z.object({
  emoji: z.string().min(1),
  target_msg_id: z.string().min(1)
});

/**
 * Shape check for an untrusted proof. Unknown keys are stripped from the
 * parsed copy only. Callers sign and display the original `signed` object.
 */
export const OutboundProofSchema = z.object({
  signed: z.object({
    type: z.literal("outbound"),
    door_id: z.string().min(1),
    epoch: z.number().int().positive(),
    msg_id: z.string().min(1),
    issued_at: z.string().min(1),
    body: z.object({
      text: z.string().optional(),
      reply_to: z.string().optional(),
      channel_id: z.string().optional(),
      reaction: reactionSchema.optional()
    })
  }),
  sig: z.string().min(1)
});

/** Original signed object plus its signature string. */
export type ProofBytes = {
  signed: Record<string, unknown>;
  sig: string;
};

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept a proof, or null. `signed` is the original object, not Zod's stripped copy,
 * so a field the schema does not name still counts in the canonical bytes.
 */
export function readProof(value: unknown): ProofBytes | null {
  try {
    const parsed = OutboundProofSchema.safeParse(value);
    if (!parsed.success || !isRecord(value)) {
      return null;
    }
    const signed = value["signed"];
    if (!isRecord(signed)) {
      return null;
    }
    return { signed, sig: parsed.data.sig };
  } catch {
    return null;
  }
}

/**
 * Room id for a wire `msg_id`. Visitor ids (`web-…`) pass through;
 * Wanderer ids are scoped by epoch so two stays cannot collide.
 */
export function roomIdFor(epoch: number, msgId: string): string {
  return msgId.startsWith("web-") ? msgId : `w${String(epoch)}-${msgId}`;
}
