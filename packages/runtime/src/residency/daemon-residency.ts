import { DoorError, sessionBindSigningPayload, WsDoorSessionClient } from "@npc/door-sdk";
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
import { helloDoor, verifyDoorHello, type DoorEndpoint } from "./doors.js";

/** Shared, residency-independent wiring for {@link arriveDaemonResidency}. */
export type DaemonResidencyContext = {
  store: SoulStore;
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
   * The Door no longer knows this attached residency (a heartbeat failed with
   * `session_invalid` or `epoch_closed`, e.g. the Door restarted). Called at most once per
   * residency; the daemon moves on instead of staying mute.
   */
  onSessionLost?: (epoch: number) => void;
};

/** Door errors meaning the Door has no live session for this residency any more. */
function isLostSessionError(error: unknown): boolean {
  return (
    error instanceof DoorError &&
    (error.code === "session_invalid" || error.code === "epoch_closed")
  );
}

/**
 * Arrive at one Door for one residency: `hello` on a fresh connection (identity pinned:
 * `door_id` must be `target.doorId` and trusted by `doorPublicKeys`; `active_epoch` crash
 * floor; `attest.memory` → the Session may form memories) → `Session.start` with a fresh
 * in-memory transcript → bind a WebSocket client to this `(door_id, epoch)`.
 *
 * Inbound frames reach the Session only while the residency is attached; after
 * {@link LiveResidency.detach} (start of a cycle) the socket is closed and any straggler
 * frame is dropped — never queued: frames are bound to the old epoch, and anything said
 * during the travel gap belongs to neither residency's transcript.
 *
 * If the socket cannot bind after the arrival attestation was appended, the session is
 * stopped (no departure — the next arrival supersedes it, as after a crash) and the error
 * propagates. A heartbeat the Door refuses as `session_invalid` / `epoch_closed` while
 * attached calls {@link DaemonResidencyContext.onSessionLost}.
 */
export async function arriveDaemonResidency(
  ctx: DaemonResidencyContext,
  target: { doorId: string; endpoint: DoorEndpoint }
): Promise<LiveResidency> {
  const { logger } = ctx;
  const doorId = target.doorId;
  const { connection: door, hello } = await helloDoor(
    target.endpoint,
    ctx.keyring.getSoulPublicKey()
  );
  logger.info(
    { door_id: hello.door_id, active_epoch: hello.active_epoch, capabilities: hello.capabilities },
    "door_hello"
  );
  if (hello.door_id !== doorId) {
    throw new DaemonError(
      `door mismatch: expected ${doorId} at ${target.endpoint.baseUrl}, door reports ${hello.door_id}`,
      "door_mismatch"
    );
  }
  const rejected = verifyDoorHello(hello, ctx.doorPublicKeys);
  if (rejected !== null) {
    throw new DaemonError(`door ${doorId} rejected: ${rejected}`, "door_mismatch");
  }

  // WHITEPAPER §3.2: raw conversation lives only in memory for the residency; depart
  // distills it into shards and destroys it. Never written to disk.
  const transcript = new ResidencyTranscript();
  const reactionsSupported = hello.capabilities.includes("session.reactions");
  const witnessesMemories = hello.capabilities.includes("attest.memory");
  logger.info(
    { attentionMode: ctx.attentionMode, reactions: reactionsSupported, witnessesMemories },
    "attention_config"
  );

  let attached = true;
  let lost = false;
  const onHeartbeatError = (error: unknown, stage: "door" | "append"): void => {
    ctx.onHeartbeatError(error, stage);
    if (attached && !lost && isLostSessionError(error)) {
      lost = true;
      logger.warn({ doorId, epoch: session.epoch }, "residency_session_lost");
      ctx.onSessionLost?.(session.epoch);
    }
  };

  const session = await Session.start({
    store: ctx.store,
    transcript,
    attention: { reactions: reactionsSupported },
    witnessesMemories,
    door,
    doorId,
    keyring: ctx.keyring,
    brain: ctx.brain,
    clock: ctx.clock,
    timer: ctx.timer,
    doorPublicKeys: ctx.doorPublicKeys,
    activeEpoch: hello.active_epoch,
    onHeartbeatError,
    ...(ctx.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: ctx.heartbeatIntervalMs }
      : {}),
    ...(ctx.onDeparted !== undefined ? { onDeparted: ctx.onDeparted } : {})
  });

  const sessionSigner = ctx.keyring.deriveSessionKey(doorId, session.epoch);
  const sessionPubkey = encodePublicKey(sessionSigner.publicKey);
  const bind = {
    door_id: doorId,
    epoch: session.epoch,
    session_pubkey: sessionPubkey,
    session_sig: encodeSignature(
      sessionSigner.sign(
        sessionBindSigningPayload({
          door_id: doorId,
          epoch: session.epoch,
          session_pubkey: sessionPubkey
        })
      )
    )
  };

  let droppedInbound = 0;

  // onInbound runs after construction, so `const` is safe for the closed-over client.
  const wsClient = new WsDoorSessionClient({
    wsBaseUrl: target.endpoint.wsBaseUrl,
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

  logger.info({ doorId, epoch: session.epoch, witnessesMemories }, "residency_live");

  return {
    doorId,
    epoch: session.epoch,
    detach,
    depart: (request) => session.depart({ journalDir: ctx.journalDir, ...request }),
    departBare: (toDoorId) => session.departBare(toDoorId),
    close
  };
}
