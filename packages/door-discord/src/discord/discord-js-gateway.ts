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
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User
} from "discord.js";

import { DiscordDoorError } from "../errors.js";
import type { DiscordGateway, GatewayCommand, GatewayMessage, GatewayReaction } from "./gateway.js";

export type DiscordJsGatewayOptions = {
  token: string;
  guildId: string;
  channelId: string;
  operatorIds: readonly string[];
};

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
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
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
    this.client.on(Events.MessageCreate, (message) => {
      void this.dispatchMessage(message);
    });
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.dispatchReaction(reaction, user);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      void this.dispatchCommand(interaction);
    });

    await this.client.login(this.options.token);
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (readyClient) => {
        this.readyBotId = readyClient.user.id;
        resolve();
      });
      this.client.once(Events.Error, (error) => {
        reject(error);
      });
    });

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
    const sent =
      replyToId === undefined
        ? await channel.send({ content })
        : await channel.send({ content, reply: { messageReference: replyToId } });
    return { id: sent.id };
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
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
      return;
    }
    await interaction.reply({ content, ephemeral: true });
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
    const mapped: GatewayMessage = {
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      authorDisplay: message.member?.displayName ?? message.author.username,
      content: message.content,
      isBot: message.author.bot,
      replyToId: message.reference?.messageId ?? undefined
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
    this.pendingEphemeral.set(interaction.id, interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === "status") {
      await handler({
        kind: "status",
        interactionId: interaction.id,
        userId: interaction.user.id,
        ephemeral: true
      });
      return;
    }
    if (sub === "approve" || sub === "reject") {
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
