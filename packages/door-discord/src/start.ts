import {
  createAiWitness,
  Door,
  HttpDoorServer,
  InProcessDoorConnection,
  openAiCompatComplete,
  WsDoorSessionServer,
  type Clock,
  type HostPolicy,
  type InboundFrame,
  type OutboundFrame,
  type SessionLifecycleEvent,
  type WitnessMemory
} from "@npc/door-sdk";
import type { Logger } from "pino";
import pino from "pino";

import type { DiscordDoorConfig } from "./config.js";
import { doorIdForGuild } from "./config.js";
import { DiscordJsGateway } from "./discord/discord-js-gateway.js";
import type { DiscordGateway } from "./discord/gateway.js";
import { MessageRelay } from "./discord/relay.js";
import { DiscordDoorError, operatorNotice } from "./errors.js";
import { loadDoorKeypairFromPath } from "./load-door-key.js";
import { DualRateLimiter, type RateClock } from "./rate-limit.js";
import { formatStatusReply, type DoorStatusSnapshot } from "./status.js";

/** Posted in the residency channel when the Wanderer arrives here. */
export const ARRIVED_NOTICE = "✨ The Wanderer has arrived.";
/** Posted in the residency channel when the Wanderer departs (travels on). */
export const MOVED_ON_NOTICE = "🌫️ The Wanderer has moved on.";

/** Wall-clock adapter for Door + rate limits. */
class SystemClock implements Clock, RateClock {
  now(): string {
    return new Date().toISOString();
  }

  nowMs(): number {
    return Date.now();
  }
}

export type SessionBridge = {
  /**
   * Handle an inbound community frame and optionally return a signed outbound reply.
   * Used by in-process tests and the manual residency harness.
   */
  handleInbound: (frame: InboundFrame) => Promise<OutboundFrame | null>;
};

export type StartDiscordDoorOptions = {
  config: DiscordDoorConfig;
  /** Inject a fake gateway in tests; defaults to discord.js binding. */
  gateway?: DiscordGateway;
  clock?: Clock & RateClock;
  logger?: Logger;
  /**
   * Memory witness override (tests). Defaults to the AI witness built from
   * `config.witness`, or none when that is `null`.
   */
  witness?: WitnessMemory;
  /**
   * When set, community messages are delivered here (in-process Session).
   * When omitted, inbound frames are broadcast on the WS session server.
   */
  sessionBridge?: SessionBridge;
  /** Skip HTTP/WS servers (unit/integration tests that only need Door + Discord). */
  disableServers?: boolean;
};

export type DiscordDoorHandle = {
  doorId: string;
  door: Door;
  /** In-process DoorConnection for Session.attest / heartbeat. */
  connection: InProcessDoorConnection;
  gateway: DiscordGateway;
  relay: MessageRelay;
  status: () => DoorStatusSnapshot;
  stop: () => Promise<void>;
};

/**
 * Start the Discord Door adapter: Door core (with the memory witness when configured),
 * optional HTTP/WS servers, Discord gateway, channel relay, and presence notices.
 */
export async function startDiscordDoor(
  options: StartDiscordDoorOptions
): Promise<DiscordDoorHandle> {
  const config = options.config;
  const logger = options.logger ?? pino({ name: "door-discord", level: "info" });
  const clock = options.clock ?? new SystemClock();
  const doorId = doorIdForGuild(config.guildId);
  const doorKeypair = loadDoorKeypairFromPath(config.doorKeyPath);

  const gateway =
    options.gateway ??
    new DiscordJsGateway({
      token: config.botToken,
      guildId: config.guildId,
      onError: (event, error) => {
        logger.warn({ event, notice: operatorNotice(error) }, "discord_dispatch_error");
      }
    });

  const witnessMemory =
    options.witness ??
    (config.witness === null
      ? undefined
      : createAiWitness({ complete: openAiCompatComplete(config.witness) }));
  // Never log the key: model name only.
  logger.info(
    { enabled: witnessMemory !== undefined, model: config.witness?.model ?? null },
    "door_witness_config"
  );

  const policy: HostPolicy = {
    community: {
      name: config.communityName,
      description: config.communityDescription,
      platform: "discord",
      invitation_required: false
    },
    // `attest.memory` is added by the Door when a witness is set.
    capabilities: [
      "session.text",
      "session.threads",
      "session.reactions",
      "session.addressing",
      "heartbeat",
      "attest"
    ],
    ...(witnessMemory === undefined ? {} : { witnessMemory })
  };

  const door = new Door({
    doorId,
    doorKeypair,
    soulPublicKey: config.soulPublicKey,
    clock,
    policy
  });

  const connection = new InProcessDoorConnection(door);

  let httpServer: HttpDoorServer | null = null;
  let wsServer: WsDoorSessionServer | null = null;

  if (options.disableServers !== true) {
    httpServer = new HttpDoorServer({
      door,
      host: config.httpHost,
      port: config.httpPort
    });
    const bound = await httpServer.start();
    logger.info(
      { host: bound.host, port: bound.port, baseUrl: bound.baseUrl },
      "door_http_listening"
    );

    wsServer = new WsDoorSessionServer({
      door,
      server: httpServer.nodeServer
    });
    const wsBound = await wsServer.start();
    logger.info({ host: wsBound.host, port: wsBound.port, url: wsBound.url }, "door_ws_listening");
  }

  const rateLimiter = new DualRateLimiter(
    config.userRatePerMinute,
    config.userBurst,
    config.channelRatePerMinute,
    config.channelBurst,
    clock
  );

  const sessionBridge = options.sessionBridge;
  const activeWs = wsServer;

  const relay = new MessageRelay({
    gateway,
    door,
    doorId,
    guildId: config.guildId,
    channelId: config.channelId,
    rateLimiter,
    logger: {
      debug: (message, fields) => {
        logger.debug({ ...fields }, message);
      },
      warn: (message, fields) => {
        logger.warn({ ...fields }, message);
      }
    },
    deliverInbound: async (frame) => {
      if (sessionBridge !== undefined) {
        const outbound = await sessionBridge.handleInbound(frame);
        if (outbound !== null) {
          // Session signs; postOutbound verifies through the Door, then posts.
          await relay.postOutbound(outbound);
        }
        return;
      }
      if (activeWs === null) {
        throw new DiscordDoorError("internal_error", "no session bridge and WS server is disabled");
      }
      // The relay already created (and recorded) this frame: send it as-is.
      activeWs.sendInbound(frame);
    },
    notifyOperators: async (notice) => {
      await gateway.sendMessage(config.channelId, notice);
    }
  });

  // WS clients: Door verifies outbound, then we post to Discord (skip re-verify).
  // The in-process bridge posts its own replies above.
  const removeOutboundListener = door.addOutboundListener((frame) => {
    if (sessionBridge !== undefined) {
      return;
    }
    void relay.postOutbound(frame, true);
  });

  const removeLifecycleListener = config.presenceNotices
    ? door.addSessionLifecycleListener(presenceNotifier(gateway, config.channelId, logger))
    : (): void => undefined;

  const operatorIds = new Set(config.operatorIds);

  gateway.onCommand(async (command) => {
    try {
      if (!operatorIds.has(command.userId)) {
        await gateway.replyEphemeral(command.interactionId, "Ignored (not an operator).");
        return;
      }
      await gateway.replyEphemeral(command.interactionId, formatStatusReply(readStatus()));
    } catch (error: unknown) {
      logger.warn({ notice: operatorNotice(error) }, "command_error");
      try {
        await gateway.replyEphemeral(command.interactionId, operatorNotice(error));
      } catch {
        // Stay up.
      }
    }
  });

  relay.attach();
  await gateway.start();

  function readStatus(): DoorStatusSnapshot {
    const epoch = door.getActiveEpoch();
    const present = epoch !== null;
    return {
      present,
      doorId,
      epoch,
      // T6.1: distinguish WS session attachment from Door active epoch, or drop this field.
      sessionLive: present,
      witnessesMemories: door.witnessesMemories()
    };
  }

  return {
    doorId,
    door,
    connection,
    gateway,
    relay,
    status: readStatus,
    stop: async () => {
      removeOutboundListener();
      removeLifecycleListener();
      await gateway.stop();
      if (wsServer !== null) {
        await wsServer.stop();
      }
      if (httpServer !== null) {
        await httpServer.stop();
      }
    }
  };
}

/**
 * Session lifecycle → presence notice in the residency channel: `arrived` and `retired`
 * post a notice; `superseded` (the Wanderer restarted here) posts nothing, and neither
 * does the arrival that immediately follows it — the Wanderer never left. Post failures
 * are logged, never thrown.
 */
function presenceNotifier(
  gateway: DiscordGateway,
  channelId: string,
  logger: Logger
): (event: SessionLifecycleEvent) => void {
  let restarting = false;
  return (event) => {
    if (event.type === "superseded") {
      restarting = true;
      return;
    }
    const afterRestart = restarting;
    restarting = false;
    if (event.type === "arrived" && afterRestart) {
      return;
    }
    const notice = event.type === "arrived" ? ARRIVED_NOTICE : MOVED_ON_NOTICE;
    void (async (): Promise<void> => {
      await gateway.sendMessage(channelId, notice);
    })().catch((error: unknown) => {
      logger.warn(
        { event: event.type, epoch: event.epoch, notice: operatorNotice(error) },
        "presence_notice_failed"
      );
    });
  };
}
