import type { Door, InboundFrame, OutboundFrame } from "@npc/door-sdk";

import { DiscordDoorError, operatorNotice } from "../errors.js";
import type { DualRateLimiter } from "../rate-limit.js";
import type { DiscordGateway, GatewayMessage } from "./gateway.js";

export type RelayLogger = {
  debug: (message: string, fields?: Record<string, string | number | boolean>) => void;
  warn: (message: string, fields?: Record<string, string | number | boolean>) => void;
};

export type MessageRelayOptions = {
  gateway: DiscordGateway;
  door: Door;
  doorId: string;
  guildId: string;
  channelId: string;
  rateLimiter: DualRateLimiter;
  logger: RelayLogger;
  /**
   * Deliver an inbound frame to the Wanderer (in-process Session bridge or WS broadcast).
   * Must not throw into Discord event loop — relay catches and posts operator notices.
   */
  deliverInbound: (frame: InboundFrame) => Promise<void>;
  /** Optional: surface DoorError-style failures to the bound channel. */
  notifyOperators?: (notice: string) => Promise<void>;
};

/**
 * Channel-bound Discord ↔ Door session relay.
 * Ignores other guilds/channels, bots, and rate-limited traffic (no in-channel reply on drop).
 */
export class MessageRelay {
  private readonly options: MessageRelayOptions;
  private msgCounter = 0;

  constructor(options: MessageRelayOptions) {
    this.options = options;
  }

  /** Wire gateway message handler (returns the promise so FakeGateway can await it). */
  attach(): void {
    this.options.gateway.onMessage((message) => this.onMessage(message));
  }

  /**
   * Post an outbound Wanderer frame to the bound channel.
   * @param alreadyVerified - set when Door already accepted the frame (WS path).
   */
  async postOutbound(frame: OutboundFrame, alreadyVerified = false): Promise<void> {
    if (!alreadyVerified) {
      try {
        this.options.door.handleOutbound(frame);
      } catch (error: unknown) {
        await this.surfaceError(error);
        return;
      }
    }

    const channelId = frame.body.channel_id ?? this.options.channelId;
    if (channelId !== this.options.channelId) {
      this.options.logger.debug("outbound_channel_mismatch", {
        channel_id: channelId,
        expected: this.options.channelId
      });
      return;
    }

    const replyToId = frame.body.reply_to;
    try {
      await this.options.gateway.sendMessage(
        this.options.channelId,
        frame.body.text,
        replyToId === undefined ? undefined : { replyToId }
      );
    } catch (error: unknown) {
      await this.surfaceError(error);
    }
  }

  private async onMessage(message: GatewayMessage): Promise<void> {
    if (message.guildId !== this.options.guildId) {
      return;
    }
    if (message.channelId !== this.options.channelId) {
      return;
    }

    const botId = this.options.gateway.botUserId();
    if (message.isBot || (botId !== null && message.authorId === botId)) {
      this.options.logger.debug("inbound_ignored_bot", { author_id: message.authorId });
      return;
    }

    const text = message.content.trim();
    if (text.length === 0) {
      return;
    }

    if (!this.options.rateLimiter.allow(message.authorId)) {
      this.options.logger.debug("inbound_rate_limited", {
        author_id: message.authorId,
        channel_id: message.channelId
      });
      return;
    }

    const epoch = this.options.door.getActiveEpoch();
    if (epoch === null) {
      this.options.logger.debug("inbound_no_active_session", {});
      return;
    }

    this.msgCounter += 1;
    const frame = this.options.door.createInboundFrame({
      msg_id: `discord-${message.id}-${String(this.msgCounter)}`,
      body: {
        text: text.slice(0, 4000),
        author_id: message.authorId,
        channel_id: message.channelId,
        ...(message.authorDisplay === undefined ? {} : { author_display: message.authorDisplay }),
        ...(message.replyToId === undefined ? {} : { reply_to: message.replyToId })
      }
    });

    // Door.createInboundFrame sets door_id/epoch from active session; re-check binding.
    if (frame.door_id !== this.options.doorId) {
      throw new DiscordDoorError(
        "internal_error",
        `inbound door_id mismatch: expected ${this.options.doorId}`
      );
    }

    try {
      await this.options.deliverInbound(frame);
    } catch (error: unknown) {
      await this.surfaceError(error);
    }
  }

  private async surfaceError(error: unknown): Promise<void> {
    const notice = operatorNotice(error);
    this.options.logger.warn("relay_error", { notice });
    const notify = this.options.notifyOperators;
    if (notify !== undefined) {
      try {
        await notify(notice);
      } catch {
        // Stay up even if the operator notice fails.
      }
    }
  }
}
