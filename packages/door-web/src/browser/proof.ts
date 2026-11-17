/**
 * Unsigned outbound frame carried to the page (`spec/door/web.md`).
 * `canonicalize` of this object is what `sig` covers.
 */
export type OutboundSigned = {
  type: "outbound";
  door_id: string;
  epoch: number;
  msg_id: string;
  issued_at: string;
  body: {
    text?: string;
    reply_to?: string;
    channel_id?: string;
    reaction?: { emoji: string; target_msg_id: string };
  };
};

/** Session-key signature over {@link OutboundSigned}. */
export type OutboundProof = {
  signed: OutboundSigned;
  sig: string;
};

/**
 * Room id for a wire `msg_id`. Visitor ids (`web-…`) are already room ids;
 * Wanderer ids are scoped by epoch so two stays cannot collide.
 */
export function roomIdFor(epoch: number, msgId: string): string {
  return msgId.startsWith("web-") ? msgId : `w${String(epoch)}-${msgId}`;
}
