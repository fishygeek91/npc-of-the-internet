/**
 * Community message arriving from Discord (already platform-parsed).
 */
export type GatewayMessage = {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorDisplay: string | undefined;
  content: string;
  isBot: boolean;
  replyToId: string | undefined;
};

/**
 * Reaction event used for cosign review (✅ / ❌).
 */
export type GatewayReaction = {
  messageId: string;
  channelId: string;
  userId: string;
  emoji: string;
};

/**
 * Slash-command invocation from an operator.
 */
export type GatewayCommand =
  | { kind: "status"; interactionId: string; userId: string; ephemeral: true }
  | {
      kind: "approve" | "reject";
      interactionId: string;
      userId: string;
      shardId: string;
      ephemeral: true;
    };

/**
 * Thin seam between the adapter and discord.js.
 * Integration tests drive a fake; production uses {@link DiscordJsGateway}.
 */
export interface DiscordGateway {
  /** Connect and begin emitting events. */
  start(): Promise<void>;
  /** Disconnect cleanly. */
  stop(): Promise<void>;
  /** Bot user id after start, or null before ready. */
  botUserId(): string | null;
  /** Post a message; returns the created message id. */
  sendMessage(
    channelId: string,
    content: string,
    options?: { replyToId?: string }
  ): Promise<{ id: string }>;
  /** Add a unicode reaction to a message. */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Reply ephemerally to a slash-command interaction. */
  replyEphemeral(interactionId: string, content: string): Promise<void>;
  onMessage(handler: (message: GatewayMessage) => void | Promise<void>): void;
  onReaction(handler: (reaction: GatewayReaction) => void | Promise<void>): void;
  onCommand(handler: (command: GatewayCommand) => void | Promise<void>): void;
}
