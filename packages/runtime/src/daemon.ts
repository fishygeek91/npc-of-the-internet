#!/usr/bin/env node

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DoorError,
  DOOR_PROTOCOL_VERSION,
  HttpDoorConnection,
  sessionBindSigningPayload,
  WsDoorSessionClient
} from "@npc/door-sdk";
import { encodePublicKey, encodeSignature, FileSoulStore } from "@npc/osp-core";
import pino, { type Logger } from "pino";

import { AnthropicBrain } from "./brain/anthropic-brain.js";
import type { Brain } from "./brain/types.js";
import { loadDaemonConfig, type DaemonConfig } from "./daemon-config.js";
import { DaemonError } from "./daemon-errors.js";
import { loadSoulPrivateKeyFromPath } from "./keyring/load-soul-key.js";
import { SingleKeyKeyring } from "./keyring/single-key-keyring.js";
import { Session } from "./session/session.js";
import type { Clock, Timer } from "./session/types.js";

/** Injectable dependencies for {@link startResidencyDaemon} (tests and production). */
export type ResidencyDaemonDeps = {
  logger?: Logger;
  brain?: Brain;
  loadSoulPrivateKey?: (path: string) => Uint8Array;
  openStore?: (
    dir: string,
    options: { doorPublicKeys: readonly Uint8Array[] }
  ) => Promise<{ store: FileSoulStore; truncatedBytes: number }>;
  /** When true, do not register SIGTERM/SIGINT handlers. */
  skipSignals?: boolean;
  /** Called after the ready file is written and residency is live. */
  onReady?: () => void;
};

/** Handle returned by {@link startResidencyDaemon} for graceful shutdown. */
export type ResidencyDaemonHandle = {
  shutdown: () => Promise<void>;
};

function createRealClock(): Clock {
  return {
    now(): string {
      return new Date().toISOString();
    }
  };
}

function createRealTimer(): Timer {
  const intervalHandles = new Map<number, ReturnType<typeof setInterval>>();
  let nextIntervalId = 1;

  return {
    setInterval(handler: () => void, ms: number): number {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervalHandles.set(id, setInterval(handler, ms));
      return id;
    },
    clearInterval(id: unknown): void {
      if (typeof id !== "number") {
        return;
      }
      const handle = intervalHandles.get(id);
      if (handle !== undefined) {
        clearInterval(handle);
        intervalHandles.delete(id);
      }
    }
  };
}

/**
 * Boot the long-running residency daemon: open soulchain, arrive at Door via HTTP,
 * bind the session WebSocket, and maintain inbound → outbound handling until shutdown.
 */
export async function startResidencyDaemon(
  config: DaemonConfig,
  deps: ResidencyDaemonDeps = {}
): Promise<ResidencyDaemonHandle> {
  const logger = deps.logger ?? pino({ name: "npc-runtime" });
  const loadSoulKey = deps.loadSoulPrivateKey ?? loadSoulPrivateKeyFromPath;
  const openStore =
    deps.openStore ?? (async (dir, options) => FileSoulStore.openWithRecovery(dir, options));

  const soulPrivateKey = loadSoulKey(config.soulKeyPath);
  const keyring = new SingleKeyKeyring(soulPrivateKey);

  const { store, truncatedBytes } = await openStore(config.soulchainDir, {
    doorPublicKeys: config.doorPublicKeys
  });
  if (truncatedBytes > 0) {
    logger.warn({ truncatedBytes }, "soulchain_recovery_truncated_torn_append");
  }

  const baseUrl = `http://${config.doorHttpHost}:${String(config.doorHttpPort)}`;
  const wsBaseUrl = `ws://${config.doorHttpHost}:${String(config.doorHttpPort)}`;
  const door = new HttpDoorConnection({ baseUrl });

  const hello = await door.hello({
    protocol_version: DOOR_PROTOCOL_VERSION,
    soul_pubkey: encodePublicKey(keyring.getSoulPublicKey())
  });
  logger.info(
    {
      door_id: hello.door_id,
      active_epoch: hello.active_epoch,
      capabilities: hello.capabilities
    },
    "door_hello"
  );
  if (hello.door_id !== config.doorId) {
    throw new DaemonError(
      `CURRENT_DOOR_ID mismatch: config has ${config.doorId}, door reports ${hello.door_id}`,
      "door_mismatch"
    );
  }

  const brain = deps.brain ?? new AnthropicBrain({ config: config.brain });
  const clock = createRealClock();
  const timer = createRealTimer();

  const session = await Session.start({
    store,
    door,
    doorId: config.doorId,
    keyring,
    brain,
    clock,
    timer,
    doorPublicKeys: config.doorPublicKeys
  });

  const sessionSigner = keyring.deriveSessionKey(config.doorId, session.epoch);
  const sessionPubkey = encodePublicKey(sessionSigner.publicKey);
  const bindPayload = sessionBindSigningPayload({
    door_id: config.doorId,
    epoch: session.epoch,
    session_pubkey: sessionPubkey
  });
  const bind = {
    door_id: config.doorId,
    epoch: session.epoch,
    session_pubkey: sessionPubkey,
    session_sig: encodeSignature(sessionSigner.sign(bindPayload))
  };

  let shuttingDown = false;

  /** Compose healthcheck target: present only while the session WebSocket is connected. */
  const setReadyFile = async (present: boolean): Promise<void> => {
    if (present) {
      const readyDir = dirname(config.readyFilePath);
      if (readyDir !== ".") {
        await mkdir(readyDir, { recursive: true });
      }
      await writeFile(config.readyFilePath, `${clock.now()}\n`, "utf8");
      return;
    }
    try {
      await unlink(config.readyFilePath);
    } catch {
      // best-effort
    }
  };

  // onInbound runs after construction, so `const` is safe for the closed-over client.
  const wsClient = new WsDoorSessionClient({
    wsBaseUrl,
    bind,
    onConnectionChange: (connected) => {
      if (shuttingDown) {
        return;
      }
      void setReadyFile(connected)
        .then(() => {
          if (connected) {
            logger.info({ readyFilePath: config.readyFilePath }, "ws_session_ready");
          } else {
            logger.warn("ws_session_disconnected");
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: message }, "ready_file_update_failed");
        });
    },
    onInbound: (frame) => {
      void (async () => {
        try {
          const result = await session.handleInbound(frame);
          if (result.ok) {
            try {
              wsClient.sendOutbound(result.outbound);
            } catch (error: unknown) {
              // Ghost contract: replies are not queued across reconnect gaps.
              if (error instanceof DoorError && error.code === "door_unavailable") {
                logger.warn({ err: error.message }, "outbound_dropped_ws_down");
                return;
              }
              throw error;
            }
            return;
          }
          if ("screened" in result && result.screened) {
            logger.warn({ categories: result.categories }, "inbound_screened");
            return;
          }
          if ("error" in result) {
            logger.warn({ err: result.error.message }, "inbound_brain_error");
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: message }, "inbound_handler_error");
        }
      })();
    }
  });

  await wsClient.connect();

  logger.info({ doorId: config.doorId, epoch: session.epoch }, "residency_live");
  deps.onReady?.();

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    await setReadyFile(false);
    await wsClient.close();
    session.stop();
    await session.drainAppends();
    await store.close();
  };

  if (!deps.skipSignals) {
    const onSignal = (): void => {
      void shutdown()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: message }, "shutdown_error");
        })
        .finally(() => {
          process.exit(0);
        });
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  return { shutdown };
}

/**
 * Production entrypoint: load env config and start the residency daemon.
 */
export async function main(): Promise<void> {
  const logger = pino({ name: "npc-runtime" });
  try {
    const config = loadDaemonConfig();
    await startResidencyDaemon(config, { logger });
    await new Promise<void>(() => {
      // kept alive until SIGTERM/SIGINT
    });
  } catch (error: unknown) {
    if (error instanceof DaemonError) {
      logger.error(
        { reason: error.reason, envVar: error.envVar, err: error.message },
        "boot_failed"
      );
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message }, "boot_failed");
    }
    process.exit(1);
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  void main();
}
