#!/usr/bin/env node

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { HttpDoorConnection } from "@npc/door-sdk";
import { DualSoulStore, FileSoulStore, type SoulStore } from "@npc/osp-core";
import pino, { type Logger } from "pino";

import { createBrain } from "./brain/create-brain.js";
import type { Brain } from "./brain/types.js";
import { loadDaemonConfig, type DaemonConfig } from "./daemon-config.js";
import { DaemonError } from "./daemon-errors.js";
import { loadSoulPrivateKeyFromPath } from "./keyring/load-soul-key.js";
import { SingleKeyKeyring } from "./keyring/single-key-keyring.js";
import {
  createAdaptersFromConfig,
  notifyDepartureForReplication,
  startReplicationDrain,
  type ReplicationDrainHandle
} from "./replication/index.js";
import { commitQuarantinedShards } from "./quarantine/commit.js";
import { watchControlDir, type ControlDirWatcher } from "./residency/control-dir.js";
import {
  abortableSleep,
  ResidencyController,
  type AbortableSleep,
  type CommitDepartedEpoch,
  type CycleOutcome,
  type CycleTrigger
} from "./residency/controller.js";
import {
  arriveDaemonResidency,
  type DaemonResidencyContext
} from "./residency/daemon-residency.js";
import type { Clock, Timer } from "./session/types.js";

/** SoulStore with lifecycle close (all runtime store implementations). */
export type ClosableSoulStore = SoulStore & {
  close(): Promise<void>;
};

/** Injectable dependencies for {@link startResidencyDaemon} (tests and production). */
export type ResidencyDaemonDeps = {
  logger?: Logger;
  brain?: Brain;
  loadSoulPrivateKey?: (path: string) => Uint8Array;
  openStore?: (
    dir: string,
    options: {
      doorPublicKeys: Readonly<Record<string, Uint8Array>>;
      soulchainIpfsDir?: string;
      replicationEnabled: boolean;
    }
  ) => Promise<{ store: ClosableSoulStore; truncatedBytes: number }>;
  /** When true, do not register SIGTERM/SIGINT (and SIGUSR2) handlers. */
  skipSignals?: boolean;
  /** Called once the first residency is live (session socket connected). */
  onReady?: () => void;
  /** Heartbeat / control-dir / residency-age timer (tests inject a fake). */
  timer?: Timer;
  /** Session heartbeat interval override (default 10 min). */
  heartbeatIntervalMs?: number;
  /** Abortable sleep for cycle backoff and commit-sweep polling (tests). */
  sleep?: AbortableSleep;
};

/** Handle returned by {@link startResidencyDaemon}. */
export type ResidencyDaemonHandle = {
  /** Graceful shutdown (no departure): abort cycle waits, close session + store. */
  shutdown: () => Promise<void>;
  /**
   * Run one residency cycle now (depart → re-arrive at the next epoch), regardless of
   * whether the operator trigger env is enabled — this is the programmatic API.
   */
  requestCycle: (trigger?: CycleTrigger) => Promise<CycleOutcome>;
  /** Epoch of the live residency, or `null` while traveling / after shutdown. */
  currentEpoch: () => number | null;
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
 * Residency cycles (depart → re-arrive) run only when a trigger is enabled in
 * `config.residency` or {@link ResidencyDaemonHandle.requestCycle} is called.
 */
export async function startResidencyDaemon(
  config: DaemonConfig,
  deps: ResidencyDaemonDeps = {}
): Promise<ResidencyDaemonHandle> {
  const logger = deps.logger ?? pino({ name: "npc-runtime" });
  const loadSoulKey = deps.loadSoulPrivateKey ?? loadSoulPrivateKeyFromPath;
  const defaultOpenStore = async (
    dir: string,
    options: {
      doorPublicKeys: Readonly<Record<string, Uint8Array>>;
      soulchainIpfsDir?: string;
      replicationEnabled: boolean;
    }
  ): Promise<{ store: ClosableSoulStore; truncatedBytes: number }> => {
    if (options.soulchainIpfsDir !== undefined) {
      return DualSoulStore.openWithRecovery(dir, options.soulchainIpfsDir, {
        doorPublicKeys: options.doorPublicKeys,
        replication: { enabled: options.replicationEnabled }
      });
    }
    return FileSoulStore.openWithRecovery(dir, {
      doorPublicKeys: options.doorPublicKeys
    });
  };
  const openStore = deps.openStore ?? defaultOpenStore;

  const soulPrivateKey = loadSoulKey(config.soulKeyPath);
  const keyring = new SingleKeyKeyring(soulPrivateKey);

  const { store, truncatedBytes } = await openStore(config.soulchainDir, {
    doorPublicKeys: config.doorPublicKeys,
    replicationEnabled: config.replication.enabled,
    ...(config.soulchainIpfsDir !== undefined ? { soulchainIpfsDir: config.soulchainIpfsDir } : {})
  });
  if (truncatedBytes > 0) {
    logger.warn({ truncatedBytes }, "soulchain_recovery_truncated_torn_append");
  }

  const resources: BootResources = { store };
  try {
    return await bootResidency({ config, deps, logger, keyring, soulPrivateKey, resources });
  } catch (error: unknown) {
    // Boot failed after the store was opened: release whatever was acquired (WS client,
    // session heartbeat timer, replication drain, store) so nothing leaks, then rethrow.
    for (const cleanupError of await releaseResources(resources)) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logger.warn({ err: message }, "boot_cleanup_failed");
    }
    throw error;
  }
}

/** Resources acquired during boot, released on boot failure or shutdown. */
type BootResources = {
  store: ClosableSoulStore;
  replicationDrain?: ReplicationDrainHandle;
  controller?: ResidencyController;
  controlWatcher?: ControlDirWatcher;
};

/**
 * Release boot resources (control watcher → residency controller [aborts any cycle wait,
 * closes the live residency: WS client + session] → replication drain → store). Every
 * step runs even when an earlier one throws, so a failing socket close still closes the
 * store. Returns the errors thrown, in order.
 */
async function releaseResources(resources: BootResources): Promise<unknown[]> {
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error: unknown) {
      errors.push(error);
    }
  };
  await step(async () => {
    resources.controlWatcher?.stop();
    await resources.controller?.shutdown();
  });
  await step(async () => {
    await resources.replicationDrain?.stop();
  });
  await step(async () => {
    await resources.store.close();
  });
  return errors;
}

/**
 * Door hello → session start → WS bind (via the {@link ResidencyController}), plus the
 * optional residency-cycle triggers; records each acquired resource in `resources`.
 */
async function bootResidency(ctx: {
  config: DaemonConfig;
  deps: ResidencyDaemonDeps;
  logger: Logger;
  keyring: SingleKeyKeyring;
  soulPrivateKey: Uint8Array;
  resources: BootResources;
}): Promise<ResidencyDaemonHandle> {
  const { config, deps, logger, keyring, soulPrivateKey, resources } = ctx;
  const { store } = resources;
  const baseUrl = `http://${config.doorHttpHost}:${String(config.doorHttpPort)}`;
  const wsBaseUrl = `ws://${config.doorHttpHost}:${String(config.doorHttpPort)}`;
  const door = new HttpDoorConnection({ baseUrl });

  const brain = deps.brain ?? createBrain(config.brain);
  const clock = createRealClock();
  const timer = deps.timer ?? createRealTimer();

  /** Counts heartbeat Door/append failures for ops visibility. */
  let heartbeatErrorCount = 0;

  let replicationDrain: ReplicationDrainHandle | undefined;
  if (config.replication.enabled && config.soulchainIpfsDir !== undefined) {
    const adapters = createAdaptersFromConfig(config.replication);
    replicationDrain = startReplicationDrain({
      ipfsDir: config.soulchainIpfsDir,
      soulPrivateKey,
      publishedCarPath: config.replication.publishedCarPath,
      manifestCidPath: config.replication.manifestCidPath,
      targets: adapters,
      intervalMs: config.replication.drainIntervalMs,
      logger
    });
    resources.replicationDrain = replicationDrain;
    logger.info(
      { targetCount: adapters.length, intervalMs: config.replication.drainIntervalMs },
      "replication_drain_started"
    );
  }

  const ipfsDir = config.soulchainIpfsDir;
  const onDeparted =
    ipfsDir !== undefined
      ? (): void => {
          void notifyDepartureForReplication({
            ipfsDir,
            soulPrivateKey,
            publishedCarPath: config.replication.publishedCarPath,
            manifestCidPath: config.replication.manifestCidPath
          }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn({ err: message }, "replication_departure_cadence_failed");
          });
        }
      : undefined;

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

  // Serialize ready-file updates so a quick disconnect → connect cannot reorder them.
  let readyFileChain: Promise<void> = Promise.resolve();
  const onConnectionChange = (connected: boolean): void => {
    if (shuttingDown) {
      return;
    }
    readyFileChain = readyFileChain
      .then(() => setReadyFile(connected))
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
  };

  const residencyCtx: DaemonResidencyContext = {
    store,
    door,
    wsBaseUrl,
    doorId: config.doorId,
    doorPublicKeys: config.doorPublicKeys,
    keyring,
    brain,
    clock,
    timer,
    logger,
    attentionMode: config.attentionMode,
    journalDir: config.residency.journalDir,
    onHeartbeatError: (error, stage) => {
      heartbeatErrorCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ err: message, stage, heartbeatErrorCount }, "heartbeat_failed");
    },
    onConnectionChange,
    ...(deps.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: deps.heartbeatIntervalMs }
      : {}),
    ...(onDeparted !== undefined ? { onDeparted } : {})
  };

  const residencyConfig = config.residency;
  const commit: CommitDepartedEpoch | undefined =
    residencyConfig.commitIntervalMs > 0
      ? ({ epoch, journalMarkdown }) =>
          commitQuarantinedShards({
            store,
            keyring,
            door,
            doorId: config.doorId,
            epoch,
            clock,
            quarantineWindowMs: residencyConfig.quarantineWindowMs,
            residency: `door:${config.doorId}/epoch:${String(epoch)}`,
            ...(journalMarkdown !== undefined ? { journalMarkdown } : {})
          })
      : undefined;

  const controller = new ResidencyController({
    arrive: () => arriveDaemonResidency(residencyCtx),
    ...(commit !== undefined
      ? {
          commit,
          commitIntervalMs: residencyConfig.commitIntervalMs,
          quarantineWindowMs: residencyConfig.quarantineWindowMs
        }
      : {}),
    maxResidencyMs: residencyConfig.maxResidencyMs,
    timerMinTranscriptLines: residencyConfig.timerMinTranscriptLines,
    nowMs: () => Date.parse(clock.now()),
    timer,
    sleep: deps.sleep ?? abortableSleep,
    logger
  });
  resources.controller = controller;
  await controller.begin();

  logger.info(
    {
      operatorTrigger: residencyConfig.operatorTrigger,
      maxResidencyMs: residencyConfig.maxResidencyMs,
      commitIntervalMs: residencyConfig.commitIntervalMs,
      journalDir: residencyConfig.journalDir
    },
    "residency_lifecycle_config"
  );

  /** Operator trigger (SIGUSR2 / `wanderer depart`): run one cycle and log the outcome. */
  const requestOperatorCycle = (source: "signal" | "control_dir"): void => {
    logger.info({ source }, "residency_cycle_requested");
    void controller.requestCycle("operator").then((outcome) => {
      logger.info({ source, ...outcome }, "residency_cycle_outcome");
    });
  };

  if (residencyConfig.operatorTrigger) {
    resources.controlWatcher = await watchControlDir({
      controlDir: residencyConfig.controlDir,
      timer,
      onDepartRequest: () => {
        requestOperatorCycle("control_dir");
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ err: message }, "control_dir_poll_failed");
      }
    });
  }

  deps.onReady?.();

  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }

    await readyFileChain;
    await setReadyFile(false);
    const errors = await releaseResources(resources);
    if (errors.length > 0) {
      throw errors[0];
    }
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
    signalHandlers.push(["SIGTERM", onSignal], ["SIGINT", onSignal]);
    // Always handle SIGUSR2: Node's default action would terminate the daemon (and the
    // restart would end the residency crash-style) if an operator signals it while the
    // trigger is off.
    signalHandlers.push([
      "SIGUSR2",
      () => {
        if (residencyConfig.operatorTrigger) {
          requestOperatorCycle("signal");
        } else {
          logger.warn("residency_cycle_signal_ignored_trigger_disabled");
        }
      }
    ]);
    for (const [signal, handler] of signalHandlers) {
      if (signal === "SIGUSR2") {
        process.on(signal, handler);
      } else {
        process.once(signal, handler);
      }
    }
  }

  return {
    shutdown,
    requestCycle: (trigger = "operator") => controller.requestCycle(trigger),
    currentEpoch: () => controller.current?.epoch ?? null
  };
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
