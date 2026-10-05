import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type MessageMentionOptions,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User
} from "discord.js";

import { DiscordDoorError } from "../errors.js";
import { clampDiscordMessage } from "./chunk.js";
import type { DiscordGateway, GatewayCommand, GatewayMessage, GatewayReaction } from "./gateway.js";

export type DiscordJsGatewayOptions = {
  token: string;
  guildId: string;
  /**
   * Called when a Discord event handler fails (message / reaction / command dispatch).
   * Errors never propagate into discord.js as unhandled rejections.
   */
  onError?: (event: string, error: unknown) => void;
};

/**
 * Mentions the bot may ping: none. Wanderer / host text is untrusted (LLM output can
 * contain `@everyone`, `<@&role>`, `<@user>`), and replies must not ping the author.
 * Returns a fresh object per send.
 */
export function noPingAllowedMentions(): MessageMentionOptions {
  return { parse: [], repliedUser: false };
}

/** Name the Wanderer answers to; bot mentions are rendered as this plain word. */
export const WANDERER_MENTION_NAME = "Wanderer";

/**
 * Replace Discord mention tokens with readable plain names (no leading `@`).
 *
 * The runtime immune screen treats `@handle` tokens as PII and drops the whole message, so
 * `cleanContent`'s `@name` rendering would silently swallow every mention. Raw `<@id>`
 * tokens are unreadable to the Wanderer. Plain names are both readable and screen-safe;
 * a bot mention becomes `Wanderer`, which the runtime also treats as addressing.
 */
export function renderMentionTokens(
  content: string,
  lookup: {
    botId: string | null;
    userName: (id: string) => string | undefined;
    channelName: (id: string) => string | undefined;
    roleName: (id: string) => string | undefined;
  }
): string {
  return content
    .replace(/(^|\s)@(everyone|here)\b/gu, "$1$2")
    .replace(/<@!?(\d+)>/gu, (_token, id: string) => {
      if (id === lookup.botId) {
        return WANDERER_MENTION_NAME;
      }
      return lookup.userName(id) ?? "someone";
    })
    .replace(/<@&(\d+)>/gu, (_token, id: string) => lookup.roleName(id) ?? "a role")
    .replace(/<#(\d+)>/gu, (_token, id: string) => {
      const name = lookup.channelName(id);
      return name === undefined ? "a channel" : `#${name}`;
    });
}

function renderMentions(message: Message, botId: string | null): string {
  return renderMentionTokens(message.content, {
    botId,
    userName: (id) =>
      message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.username,
    channelName: (id) => {
      const channel = message.mentions.channels.get(id);
      return channel !== undefined && "name" in channel && typeof channel.name === "string"
        ? channel.name
        : undefined;
    },
    roleName: (id) => message.mentions.roles.get(id)?.name
  });
}

/**
 * Real discord.js binding for {@link DiscordGateway}.
 * Exercised via MANUAL_TEST.md — not mocked class-by-class in CI.
 */
export class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private readonly options: DiscordJsGatewayOptions;
  private readyBotId: string | null = null;
  private messageHandler: ((message: GatewayMessage) => void | Promise<void>) | null = null;
  private reactionHandler: ((reaction: GatewayReaction) => void | Promise<void>) | null = null;
  private commandHandler: ((command: GatewayCommand) => void | Promise<void>) | null = null;
  private readonly pendingEphemeral = new Map<string, ChatInputCommandInteraction>();

  constructor(options: DiscordJsGatewayOptions) {
    this.options = options;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
      // Client-wide default; every send also passes allowedMentions explicitly.
      allowedMentions: noPingAllowedMentions(),
      failIfNotExists: false
    });
    // Wired once here (events only flow after login in start()).
    this.client.on(Events.MessageCreate, (message) => {
      this.guard("message", () => this.dispatchMessage(message));
    });
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      this.guard("reaction", () => this.dispatchReaction(reaction, user));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      this.guard("command", () => this.dispatchCommand(interaction));
    });
  }

  botUserId(): string | null {
    return this.readyBotId;
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
    // Register ready/error before login so we never miss a fast ready event.
    const ready = new Promise<void>((resolve, reject) => {
      const onReady = (readyClient: { user: { id: string } }): void => {
        cleanup();
        this.readyBotId = readyClient.user.id;
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        this.client.off(Events.ClientReady, onReady);
        this.client.off(Events.Error, onError);
      };
      this.client.once(Events.ClientReady, onReady);
      this.client.once(Events.Error, onError);
    });

    await this.client.login(this.options.token);
    await ready;
    await this.registerSlashCommands();
  }

  async stop(): Promise<void> {
    this.client.destroy();
    this.readyBotId = null;
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: { replyToId?: string }
  ): Promise<{ id: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || channel.isDMBased()) {
      throw new DiscordDoorError(
        "discord_error",
        `channel ${channelId} is not a guild text channel`
      );
    }
    const replyToId = options?.replyToId;
    // Last-resort length guard (relay chunks Wanderer text before reaching here).
    const safeContent = clampDiscordMessage(content);
    const sent =
      replyToId === undefined
        ? await channel.send({ content: safeContent, allowedMentions: noPingAllowedMentions() })
        : await channel.send({
            content: safeContent,
            allowedMentions: noPingAllowedMentions(),
            // A deleted parent must not fail the send (spec: post without the reference).
            reply: { messageReference: replyToId, failIfNotExists: false }
          });
    return { id: sent.id };
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || channel.isDMBased()) {
      return;
    }
    await channel.sendTyping();
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || channel.isDMBased()) {
      throw new DiscordDoorError(
        "discord_error",
        `channel ${channelId} is not a guild text channel`
      );
    }
    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
  }

  async replyEphemeral(interactionId: string, content: string): Promise<void> {
    const interaction = this.pendingEphemeral.get(interactionId);
    if (interaction === undefined) {
      throw new DiscordDoorError("discord_error", "unknown interaction for ephemeral reply");
    }
    this.pendingEphemeral.delete(interactionId);
    const safeContent = clampDiscordMessage(content);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: safeContent,
        ephemeral: true,
        allowedMentions: noPingAllowedMentions()
      });
      return;
    }
    await interaction.reply({
      content: safeContent,
      ephemeral: true,
      allowedMentions: noPingAllowedMentions()
    });
  }

  /** Run an async event handler; failures go to `onError`, never unhandled rejections. */
  private guard(event: string, run: () => Promise<void>): void {
    let pending: Promise<void>;
    try {
      pending = run();
    } catch (error: unknown) {
      this.reportError(event, error);
      return;
    }
    pending.catch((error: unknown) => {
      this.reportError(event, error);
    });
  }

  private reportError(event: string, error: unknown): void {
    try {
      this.options.onError?.(event, error);
    } catch {
      // The error reporter itself must never take the gateway down.
    }
  }

  private async registerSlashCommands(): Promise<void> {
    const body = [
      new SlashCommandBuilder()
        .setName("wanderer")
        .setDescription("Wanderer host operator commands")
        .addSubcommand((sub) => sub.setName("status").setDescription("Show residency status"))
        .addSubcommand((sub) =>
          sub
            .setName("approve")
            .setDescription("Approve a candidate shard")
            .addStringOption((opt) =>
              opt.setName("shard_id").setDescription("Shard id").setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("reject")
            .setDescription("Reject a candidate shard")
            .addStringOption((opt) =>
              opt.setName("shard_id").setDescription("Shard id").setRequired(true)
            )
        )
        .toJSON()
    ];

    const rest = new REST({ version: "10" }).setToken(this.options.token);
    const appId = this.client.application?.id;
    if (appId === undefined) {
      throw new DiscordDoorError("discord_error", "Discord application id unavailable after ready");
    }
    await rest.put(Routes.applicationGuildCommands(appId, this.options.guildId), { body });
  }

  private async dispatchMessage(message: Message): Promise<void> {
    if (message.guildId === null) {
      return;
    }
    const handler = this.messageHandler;
    if (handler === null) {
      return;
    }
    const botId = this.readyBotId;
    const mentionsBot =
      botId !== null &&
      (message.mentions.users.has(botId) || message.mentions.repliedUser?.id === botId);
    const mapped: GatewayMessage = {
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      authorDisplay: message.member?.displayName ?? message.author.username,
      content: renderMentions(message, botId),
      isBot: message.author.bot,
      replyToId: message.reference?.messageId ?? undefined,
      mentionsBot
    };
    await handler(mapped);
  }

  private async dispatchReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (user.bot === true) {
      return;
    }
    const handler = this.reactionHandler;
    if (handler === null) {
      return;
    }
    const full =
      reaction.partial || user.partial ? await reaction.fetch().catch(() => null) : reaction;
    if (full === null) {
      return;
    }
    const message = full.message.partial ? await full.message.fetch() : full.message;
    const emoji = full.emoji.name;
    if (emoji === null) {
      return;
    }
    const mapped: GatewayReaction = {
      messageId: message.id,
      channelId: message.channelId,
      userId: user.id,
      emoji
    };
    await handler(mapped);
  }

  private async dispatchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== "wanderer") {
      return;
    }
    const handler = this.commandHandler;
    if (handler === null) {
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "status") {
      this.pendingEphemeral.set(interaction.id, interaction);
      await handler({
        kind: "status",
        interactionId: interaction.id,
        userId: interaction.user.id,
        ephemeral: true
      });
      return;
    }
    if (sub === "approve" || sub === "reject") {
      this.pendingEphemeral.set(interaction.id, interaction);
      const shardId = interaction.options.getString("shard_id", true);
      await handler({
        kind: sub,
        interactionId: interaction.id,
        userId: interaction.user.id,
        shardId,
        ephemeral: true
      });
    }
  }
}
