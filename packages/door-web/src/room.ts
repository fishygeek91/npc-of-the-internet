import type { OutboundProof } from "./browser/proof.js";

/** Who said a room line. */
export type RoomAuthorKind = "visitor" | "wanderer" | "system";

/** One Wanderer reaction, with the signed outbound frame that produced it. */
export type RoomReaction = {
  emoji: string;
  proof: OutboundProof;
};

/** One line in the shared room, as served to browsers. */
export type RoomMessage = {
  id: string;
  at: string;
  from: RoomAuthorKind;
  /** Display name (visitor's chosen name, "The Wanderer"); absent for system lines. */
  name?: string;
  text: string;
  /** `id` of the room message this one answers (Wanderer replies). */
  reply_to?: string;
  /**
   * Signed outbound frame for a Wanderer line. Absent for visitors and system
   * notices, which must not be treated as verified speech.
   */
  proof?: OutboundProof;
  /** Distinct reaction emoji the Wanderer left on this message. */
  reactions: RoomReaction[];
};

export type { OutboundProof } from "./browser/proof.js";

/** Events a room emits to its listeners (the SSE fan-out). */
export type RoomEvent =
  | { type: "message"; message: RoomMessage }
  | { type: "reaction"; target: string; emoji: string; proof: OutboundProof };

/** Lines kept in memory. */
export const ROOM_CAPACITY = 200;
/** Distinct reactions kept per message. */
const MAX_REACTIONS = 8;

/**
 * The shared room: an in-memory ring of the last {@link ROOM_CAPACITY} lines. Nothing is
 * written to disk; a restart empties it.
 */
export class Room {
  private readonly messages: RoomMessage[] = [];
  private readonly listeners = new Set<(event: RoomEvent) => void>();

  /** Subscribe to room events. Returns an unsubscribe function. */
  subscribe(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Append a line (evicting the oldest past capacity) and broadcast it. */
  append(message: Omit<RoomMessage, "reactions">): RoomMessage {
    const stored: RoomMessage = { ...message, reactions: [] };
    this.messages.push(stored);
    while (this.messages.length > ROOM_CAPACITY) {
      this.messages.shift();
    }
    this.emit({ type: "message", message: stored });
    return stored;
  }

  /** Record a reaction on a message still in the ring; false when unknown or full. */
  react(target: string, emoji: string, proof: OutboundProof): boolean {
    const message = this.messages.find((candidate) => candidate.id === target);
    if (message === undefined) {
      return false;
    }
    if (!message.reactions.some((reaction) => reaction.emoji === emoji)) {
      if (message.reactions.length >= MAX_REACTIONS) {
        return false;
      }
      message.reactions.push({ emoji, proof });
    }
    this.emit({ type: "reaction", target, emoji, proof });
    return true;
  }

  /** The last `limit` lines, oldest first. */
  recent(limit: number): RoomMessage[] {
    return this.messages.slice(-limit).map((message) => {
      const copy: RoomMessage = {
        id: message.id,
        at: message.at,
        from: message.from,
        text: message.text,
        reactions: message.reactions.map((reaction) => ({
          emoji: reaction.emoji,
          proof: reaction.proof
        }))
      };
      if (message.name !== undefined) {
        copy.name = message.name;
      }
      if (message.reply_to !== undefined) {
        copy.reply_to = message.reply_to;
      }
      if (message.proof !== undefined) {
        copy.proof = message.proof;
      }
      return copy;
    });
  }

  private emit(event: RoomEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken listener must not stop the others.
      }
    }
  }
}
