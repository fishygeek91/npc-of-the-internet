import type {
  DiscordGateway,
  GatewayCommand,
  GatewayMessage,
  GatewayReaction
} from "../../src/discord/gateway.js";

/**
 * In-memory DiscordGateway for CI — no discord.js, no network.
 */
export class FakeGateway implements DiscordGateway {
  private botId: string | null = null;
  private messageHandler: ((message: GatewayMessage) => void | Promise<void>) | null = null;
  private reactionHandler: ((reaction: GatewayReaction) => void | Promise<void>) | null = null;
  private commandHandler: ((command: GatewayCommand) => void | Promise<void>) | null = null;
  private nextMessageId = 1;

  readonly sent: Array<{ channelId: string; content: string; replyToId?: string; id: string }> = [];
  readonly reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  readonly ephemerals: Array<{ interactionId: string; content: string }> = [];

  constructor(private readonly configuredBotId = "bot-1") {}

  botUserId(): string | null {
    return this.botId;
  }

  onMessage(handler: (message: GatewayMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onReaction(handler: (reaction: GatewayReaction) => void | Promise<void>): void {
    this.reactionHandler = handler;
  }

  onCommand(handler: (command: GatewayCommand) => void | Promise<void>): void {
    this.commandHandler = handler;
  }

  async start(): Promise<void> {
    this.botId = this.configuredBotId;
  }

  async stop(): Promise<void> {
    this.botId = null;
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyToId?: string }
  ): Promise<{ id: string }> {
    const id = `msg-${String(this.nextMessageId)}`;
    this.nextMessageId += 1;
    const entry: { channelId: string; content: string; replyToId?: string; id: string } = {
      channelId,
      content,
      id
    };
    if (options?.replyToId !== undefined) {
      entry.replyToId = options.replyToId;
    }
    this.sent.push(entry);
    return { id };
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji });
  }

  async replyEphemeral(interactionId: string, content: string): Promise<void> {
    this.ephemerals.push({ interactionId, content });
  }

  /** Simulate a community (or bot) message. */
  async emitMessage(message: GatewayMessage): Promise<void> {
    const handler = this.messageHandler;
    if (handler !== null) {
      await handler(message);
    }
  }

  /** Simulate a reaction add. */
  async emitReaction(reaction: GatewayReaction): Promise<void> {
    const handler = this.reactionHandler;
    if (handler !== null) {
      await handler(reaction);
    }
  }

  /** Simulate a slash command. */
  async emitCommand(command: GatewayCommand): Promise<void> {
    const handler = this.commandHandler;
    if (handler !== null) {
      await handler(command);
    }
  }
}
