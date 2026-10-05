import {
  DoorError,
  DOOR_PROTOCOL_VERSION,
  sessionBindSigningPayload,
  WsDoorSessionClient,
  type HelloResponse,
  type HttpDoorConnection
} from "@npc/door-sdk";
import { encodePublicKey, encodeSignature, type SoulStore } from "@npc/osp-core";
import type { Logger } from "pino";

import type { Brain } from "../brain/types.js";
import type { AttentionMode } from "../daemon-config.js";
import { DaemonError } from "../daemon-errors.js";
import { ResidencyTranscript } from "../distill/residency-transcript.js";
import type { SingleKeyKeyring } from "../keyring/single-key-keyring.js";
import { SessionError } from "../session/errors.js";
import { Session } from "../session/session.js";
import type { Clock, InboundFrame, OutboundFrame, Timer } from "../session/types.js";
import type { LiveResidency } from "./controller.js";

/** Shared, residency-independent wiring for {@link arriveDaemonResidency}. */
export type DaemonResidencyContext = {
  store: SoulStore;
  door: HttpDoorConnection;
  wsBaseUrl: string;
  doorId: string;
  doorPublicKeys: Readonly<Record<string, Uint8Array>>;
  keyring: SingleKeyKeyring;
  brain: Brain;
  clock: Clock;
  timer: Timer;
  logger: Logger;
  attentionMode: AttentionMode;
  journalDir: string;
  heartbeatIntervalMs?: number;
  onDeparted?: () => void;
  onHeartbeatError: (error: unknown, stage: "door" | "append") => void;
  /** Ready-file hook: `true` once this residency's socket is connected, `false` on drop. */
  onConnectionChange: (connected: boolean) => void;
  /**
   * Called with the verified `hello` before `Session.start` (nothing appended yet);
   * throwing aborts this arrival (boot-time capability checks).
   */
  onHello?: (hello: HelloResponse) => void;
};

/** Door capability: completed cosign reviews are retained per epoch across arrivals. */
export const PAST_EPOCH_COMMITS_CAPABILITY = "cosign.past_epochs";

/**
 * Arrive at the Door for one residency: `hello` (door id check + `active_epoch` crash
 * floor) → `Session.start` with a fresh in-memory transcript → bind a WebSocket client
 * to this `(door_id, epoch)`.
 *
 * Inbound frames reach the Session only while the residency is attached; after
 * {@link LiveResidency.detach} (start of a cycle) the socket is closed and any straggler
 * frame is dropped — never queued: frames are bound to the old epoch, and anything said
 * during the travel gap belongs to neither residency's transcript.
 *
 * If the socket cannot bind after the arrival attestation was appended, the session is
 * stopped (no departure — the next arrival supersedes it, as after a crash) and the error
 * propagates.
 */
export async function arriveDaemonResidency(ctx: DaemonResidencyContext): Promise<LiveResidency> {
  const { logger } = ctx;
  const hello = await ctx.door.hello({
    protocol_version: DOOR_PROTOCOL_VERSION,
    soul_pubkey: encodePublicKey(ctx.keyring.getSoulPublicKey())
  });
  logger.info(
    { door_id: hello.door_id, active_epoch: hello.active_epoch, capabilities: hello.capabilities },
    "door_hello"
  );
  if (hello.door_id !== ctx.doorId) {
    throw new DaemonError(
      `CURRENT_DOOR_ID mismatch: config has ${ctx.doorId}, door reports ${hello.door_id}`,
      "door_mismatch"
    );
  }

  ctx.onHello?.(hello);

  // WHITEPAPER §3.2: raw conversation lives only in memory for the residency; depart
  // distills it into shards and destroys it. Never written to disk.
  const transcript = new ResidencyTranscript();
  const reactionsSupported = hello.capabilities.includes("session.reactions");
  logger.info(
    { attentionMode: ctx.attentionMode, reactions: reactionsSupported },
    "attention_config"
  );

  const session = await Session.start({
    store: ctx.store,
    transcript,
    attention: { reactions: reactionsSupported },
    door: ctx.door,
    doorId: ctx.doorId,
    keyring: ctx.keyring,
    brain: ctx.brain,
    clock: ctx.clock,
    timer: ctx.timer,
    doorPublicKeys: ctx.doorPublicKeys,
    activeEpoch: hello.active_epoch,
    onHeartbeatError: ctx.onHeartbeatError,
    ...(ctx.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: ctx.heartbeatIntervalMs }
      : {}),
    ...(ctx.onDeparted !== undefined ? { onDeparted: ctx.onDeparted } : {})
  });

  const sessionSigner = ctx.keyring.deriveSessionKey(ctx.doorId, session.epoch);
  const sessionPubkey = encodePublicKey(sessionSigner.publicKey);
  const bind = {
    door_id: ctx.doorId,
    epoch: session.epoch,
    session_pubkey: sessionPubkey,
    session_sig: encodeSignature(
      sessionSigner.sign(
        sessionBindSigningPayload({
          door_id: ctx.doorId,
          epoch: session.epoch,
          session_pubkey: sessionPubkey
        })
      )
    )
  };

  let attached = true;
  let droppedInbound = 0;

  // onInbound runs after construction, so `const` is safe for the closed-over client.
  const wsClient = new WsDoorSessionClient({
    wsBaseUrl: ctx.wsBaseUrl,
    bind,
    onConnectionChange: (connected) => {
      if (attached) {
        ctx.onConnectionChange(connected);
      }
    },
    onInbound: (frame) => {
      if (!attached) {
        droppedInbound += 1;
        return;
      }
      void (async () => {
        try {
          if (ctx.attentionMode === "selective") {
            await handleObserved(frame);
          } else {
            await handleAlways(frame);
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (!attached && error instanceof SessionError) {
            // The residency began departing while this frame was in flight.
            droppedInbound += 1;
            logger.debug({ err: message }, "inbound_dropped_departing");
            return;
          }
          logger.error({ err: message }, "inbound_handler_error");
        }
      })();
    }
  });

  /** Send a signed outbound frame; replies are not queued across reconnect gaps (Ghost contract). */
  const sendOutbound = (outbound: OutboundFrame): void => {
    try {
      wsClient.sendOutbound(outbound);
    } catch (error: unknown) {
      if (error instanceof DoorError && error.code === "door_unavailable") {
        logger.warn({ err: error.message }, "outbound_dropped_ws_down");
        return;
      }
      throw error;
    }
  };

  /** Selective attention: the Wanderer decides to speak, react, or stay quiet. */
  const handleObserved = async (frame: InboundFrame): Promise<void> => {
    const result = await session.observe(frame);
    switch (result.kind) {
      case "acted":
        logger.info(
          {
            spoke: result.spoke,
            reacted: result.reacted,
            batchSize: result.batchSize,
            notes: result.notes
          },
          "attention_acted"
        );
        sendOutbound(result.outbound);
        return;
      case "silent":
        logger.info({ batchSize: result.batchSize, notes: result.notes }, "attention_silent");
        return;
      case "coalesced":
        logger.debug("attention_coalesced");
        return;
      case "screened":
        logger.warn({ categories: result.categories }, "inbound_screened");
        return;
      case "error":
        logger.warn({ err: result.error.message }, "inbound_brain_error");
        return;
    }
  };

  /** Legacy door/0.1 behaviour: answer every inbound message. */
  const handleAlways = async (frame: InboundFrame): Promise<void> => {
    const result = await session.handleInbound(frame);
    if (result.ok) {
      sendOutbound(result.outbound);
      return;
    }
    if ("screened" in result && result.screened) {
      logger.warn({ categories: result.categories }, "inbound_screened");
      return;
    }
    if ("error" in result) {
      logger.warn({ err: result.error.message }, "inbound_brain_error");
    }
  };

  const detach = async (): Promise<void> => {
    if (attached) {
      attached = false;
      ctx.onConnectionChange(false);
    }
    await wsClient.close();
    if (droppedInbound > 0) {
      logger.info({ epoch: session.epoch, droppedInbound }, "inbound_dropped_travel_gap");
      droppedInbound = 0;
    }
  };

  const close = async (): Promise<void> => {
    // Detach first so no inbound frame races the stop; then drain heartbeat appends.
    let detachError: unknown = null;
    try {
      await detach();
    } catch (error: unknown) {
      detachError = error;
    }
    session.stop();
    await session.drainAppends();
    if (detachError !== null) {
      throw detachError;
    }
  };

  try {
    await wsClient.connect();
  } catch (error: unknown) {
    await close().catch(() => undefined);
    throw error;
  }

  logger.info({ doorId: ctx.doorId, epoch: session.epoch }, "residency_live");

  return {
    epoch: session.epoch,
    transcriptSize: () => transcript.size,
    detach,
    depart: () => session.depart({ journalDir: ctx.journalDir, toDoorId: ctx.doorId }),
    close,
    pastEpochCommits: hello.capabilities.includes(PAST_EPOCH_COMMITS_CAPABILITY),
    withAppendLock: (fn) => session.withAppendLock(fn)
  };
}
