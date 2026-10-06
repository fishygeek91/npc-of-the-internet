/** Who said a room line. */
export type RoomAuthorKind = "visitor" | "wanderer" | "system";

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
  /** Distinct reaction emoji the Wanderer left on this message. */
  reactions: string[];
};

/** Events a room emits to its listeners (the SSE fan-out). */
export type RoomEvent =
  { type: "message"; message: RoomMessage } | { type: "reaction"; target: string; emoji: string };

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

  /** Record a reaction on a message still in the ring; false when unknown. */
  react(target: string, emoji: string): boolean {
    const message = this.messages.find((candidate) => candidate.id === target);
    if (message === undefined) {
      return false;
    }
    if (!message.reactions.includes(emoji)) {
      if (message.reactions.length >= MAX_REACTIONS) {
        return false;
      }
      message.reactions.push(emoji);
    }
    this.emit({ type: "reaction", target, emoji });
    return true;
  }

  /** The last `limit` lines, oldest first. */
  recent(limit: number): RoomMessage[] {
    return this.messages.slice(-limit).map((message) => ({
      ...message,
      reactions: [...message.reactions]
    }));
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
