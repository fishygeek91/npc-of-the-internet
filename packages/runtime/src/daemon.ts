#!/usr/bin/env node

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { DoorError } from "@npc/door-sdk";
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
import { watchControlDir, type ControlDirWatcher } from "./residency/control-dir.js";
import {
  abortableSleep,
  ResidencyController,
  type AbortableSleep,
  type CycleOutcome,
  type CycleTrigger
} from "./residency/controller.js";
import {
  arriveDaemonResidency,
  type DaemonResidencyContext
} from "./residency/daemon-residency.js";
import { doorEndpoint, probeDoors, type DoorEndpoint } from "./residency/doors.js";
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
  /** Abortable sleep for cycle and arrival backoff (tests). */
  sleep?: AbortableSleep;
  /** Wall clock override (tests); defaults to the system clock. */
  clock?: Clock;
  /** Uniform `[0, 1)` source for choosing the next Door (tests); defaults to `Math.random`. */
  random?: () => number;
  /** Per-Door `hello` timeout while probing (default 10 s). */
  doorProbeTimeoutMs?: number;
  /** Depart retry backoff override (default 30 s, 120 s). */
  departRetryDelaysMs?: readonly number[];
  /** First arrival retry delay override (default 5 s). */
  arriveRetryBaseMs?: number;
};

/** Handle returned by {@link startResidencyDaemon}. */
export type ResidencyDaemonHandle = {
  /** Graceful shutdown (no departure): abort cycle waits, close session + store. */
  shutdown: () => Promise<void>;
  /**
   * Run one residency cycle now (depart → travel → arrive at the next Door), regardless of
   * whether the operator trigger env is enabled — this is the programmatic API.
   */
  requestCycle: (trigger?: CycleTrigger) => Promise<CycleOutcome>;
  /** Epoch of the live residency, or `null` while traveling / after shutdown. */
  currentEpoch: () => number | null;
  /** Door of the live residency, or `null` while traveling / after shutdown. */
  currentDoorId: () => string | null;
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
 * Boot the long-running residency daemon: open the soulchain, probe the configured Doors,
 * arrive at one (where the chain says the Wanderer is — the last travel's `to_door_id` when
 * no arrival followed it, else the last arrival's Door — if online, else `CURRENT_DOOR_ID`,
 * else a random online Door — retrying with backoff while none is online; SIGTERM/SIGINT
 * already stop it then), bind the session WebSocket,
 * and maintain inbound → outbound handling until shutdown. Residency cycles (depart →
 * travel → arrive at another online Door) run on the residency timer, the operator
 * trigger, or {@link ResidencyDaemonHandle.requestCycle}.
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
 * Door probe → hello → session start → WS bind (via the {@link ResidencyController}), plus
 * the residency-cycle triggers; records each acquired resource in `resources`.
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
  const endpoints = config.doorUrls.map(doorEndpoint);

  const brain = deps.brain ?? createBrain(config.brain);
  const clock = deps.clock ?? createRealClock();
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

  const residencyConfig = config.residency;

  const residencyCtx: DaemonResidencyContext = {
    store,
    doorPublicKeys: config.doorPublicKeys,
    keyring,
    brain,
    clock,
    timer,
    logger,
    attentionMode: config.attentionMode,
    journalDir: residencyConfig.journalDir,
    onHeartbeatError: (error, stage) => {
      heartbeatErrorCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ err: message, stage, heartbeatErrorCount }, "heartbeat_failed");
    },
    onConnectionChange,
    onSessionLost: (epoch) => {
      if (controller.current?.epoch === epoch) {
        void controller.requestCycle("lost_session");
      }
    },
    ...(deps.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: deps.heartbeatIntervalMs }
      : {}),
    ...(onDeparted !== undefined ? { onDeparted } : {})
  };

  /** Endpoints of the Doors the last probe found online (arrive needs the URL). */
  const online = new Map<string, DoorEndpoint>();
  const probe = async (): Promise<string[]> => {
    const available = await probeDoors({
      endpoints,
      soulPublicKey: keyring.getSoulPublicKey(),
      doorPublicKeys: config.doorPublicKeys,
      logger,
      ...(deps.doorProbeTimeoutMs !== undefined ? { timeoutMs: deps.doorProbeTimeoutMs } : {})
    });
    online.clear();
    for (const door of available) {
      online.set(door.doorId, door.endpoint);
    }
    return available.map((door) => door.doorId);
  };

  const controller = new ResidencyController({
    probe,
    arrive: async (doorId) => {
      const endpoint = online.get(doorId);
      if (endpoint === undefined) {
        throw new DaemonError(`door ${doorId} is not online`, "door_mismatch");
      }
      return arriveDaemonResidency(residencyCtx, { doorId, endpoint });
    },
    bootPreference: async () => {
      const last = await lastDoorId(store);
      return [last, config.preferredDoorId].filter(
        (doorId): doorId is string => doorId !== undefined && doorId !== null
      );
    },
    // Door trouble (unreachable, refused, swapped identity) is retried; local failures
    // (invalid chain, spec cutover, storage) fail boot.
    isFatalBootError: (error) =>
      !(
        error instanceof DoorError ||
        (error instanceof DaemonError && error.reason === "door_mismatch")
      ),
    maxResidencyMs: residencyConfig.maxResidencyMs,
    minMemoryLines: residencyConfig.minMemoryLines,
    nowMs: () => Date.parse(clock.now()),
    timer,
    sleep: deps.sleep ?? abortableSleep,
    logger,
    ...(deps.random !== undefined ? { random: deps.random } : {}),
    ...(deps.departRetryDelaysMs !== undefined
      ? { departRetryDelaysMs: deps.departRetryDelaysMs }
      : {}),
    ...(deps.arriveRetryBaseMs !== undefined ? { arriveRetryBaseMs: deps.arriveRetryBaseMs } : {})
  });
  resources.controller = controller;

  logger.info(
    {
      doors: config.doorUrls,
      maxResidencyMs: residencyConfig.maxResidencyMs,
      minLines: residencyConfig.minMemoryLines,
      operatorTrigger: residencyConfig.operatorTrigger,
      journalDir: residencyConfig.journalDir
    },
    "residency_lifecycle_config"
  );

  /** Operator trigger (SIGUSR2 / `wanderer depart`): run one cycle (it logs its outcome). */
  const requestOperatorCycle = (source: "signal" | "control_dir"): void => {
    logger.info({ source }, "residency_cycle_requested");
    void controller.requestCycle("operator");
  };

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

  // Registered before the first arrival so SIGTERM works while no Door is reachable.
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

  const handle: ResidencyDaemonHandle = {
    shutdown,
    requestCycle: (trigger = "operator") => controller.requestCycle(trigger),
    currentEpoch: () => controller.current?.epoch ?? null,
    currentDoorId: () => controller.current?.doorId ?? null
  };

  try {
    await controller.begin();

    if (residencyConfig.operatorTrigger) {
      const watcher = await watchControlDir({
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
      resources.controlWatcher = watcher;
      if (shuttingDown) {
        // A signal released everything while the watcher was starting.
        watcher.stop();
      }
    }

    deps.onReady?.();
  } catch (error: unknown) {
    if (shuttingDown) {
      // A signal stopped the daemon during boot; shutdown released everything.
      return handle;
    }
    // Boot failed after the signal handlers were registered (arrival, control dir, …):
    // unregister them and clear the ready file; startResidencyDaemon then releases the
    // controller (live residency), replication drain and store.
    shuttingDown = true;
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    await readyFileChain;
    await setReadyFile(false);
    throw error;
  }

  return handle;
}

/**
 * Where the chain says the Wanderer is (boot preference): the `to_door_id` of the last
 * `travel` when it comes after the last `arrival` (it left, the arrival never happened),
 * else the last arrival's Door (also when that travel has no `to_door_id`), else `null`.
 */
async function lastDoorId(store: SoulStore): Promise<string | null> {
  let doorId: string | null = null;
  for await (const record of store.iterate()) {
    if (record.type !== "attestation") {
      continue;
    }
    if (record.body.kind === "arrival") {
      doorId = record.body.door_id;
    } else if (record.body.kind === "travel" && record.body.to_door_id !== undefined) {
      // A travel without a destination says nothing about where to go: keep the arrival's Door.
      doorId = record.body.to_door_id;
    }
  }
  return doorId;
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
