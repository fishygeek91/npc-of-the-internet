import type { Logger } from "pino";

import { DEFAULT_MIN_MEMORY_LINES, type DepartResult } from "../session/session.js";
import type { Timer } from "../session/types.js";

/** What started a residency cycle. */
export type CycleTrigger = "operator" | "timer";

/**
 * Outcome of {@link ResidencyController.requestCycle}.
 *
 * - `cycled`: departed (witnessed memories → journal → departure + travel) and arrived at
 *   `toDoor` / `toEpoch`.
 * - `abandoned`: depart kept failing; departure + travel were attempted without memories
 *   (best effort) and the Wanderer arrived at `toDoor` / `toEpoch` anyway.
 * - `busy`: another cycle is already running (single-flight).
 * - `shutting_down`: the daemon is stopping; no cycle started.
 * - `aborted`: shutdown interrupted the cycle; no arrival (next boot arrives).
 */
export type CycleOutcome =
  | {
      kind: "cycled";
      trigger: CycleTrigger;
      fromDoor: string;
      toDoor: string;
      fromEpoch: number;
      toEpoch: number;
      witnessed: number;
      declined: number;
      journalPath: string | null;
    }
  | {
      kind: "abandoned";
      trigger: CycleTrigger;
      fromDoor: string;
      toDoor: string;
      fromEpoch: number;
      toEpoch: number;
      error: string;
    }
  | { kind: "busy"; trigger: CycleTrigger }
  | { kind: "shutting_down"; trigger: CycleTrigger }
  | { kind: "aborted"; trigger: CycleTrigger; fromEpoch: number };

/** Arguments for {@link LiveResidency.depart}. */
export type DepartRequest = {
  /** Next Door (travel `to_door_id`); omitted when no Door was available. */
  toDoorId?: string;
  /** Fewer transcript lines than this form no memories. */
  minMemoryLines: number;
};

/** One live residency (Session + its Door session socket) as seen by the controller. */
export interface LiveResidency {
  /** Door hosting this residency. */
  readonly doorId: string;
  /** Global residency epoch. */
  readonly epoch: number;
  /**
   * Stop delivering Door session traffic to this residency (close its WebSocket client;
   * later inbound frames are dropped). Idempotent.
   */
  detach(): Promise<void>;
  /** End the residency via `Session.depart` (retryable after a mid-pipeline failure). */
  depart(request: DepartRequest): Promise<DepartResult>;
  /** Departure + travel without memories (`Session.departBare`), after depart gave up. */
  departBare(toDoorId?: string): Promise<void>;
  /** Release without departure (shutdown): stop heartbeats, drain appends, detach. */
  close(): Promise<void>;
}

/** Abortable sleep; must reject (or resolve) promptly when `signal` aborts. */
export type AbortableSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Options for {@link ResidencyController}. */
export type ResidencyControllerOptions = {
  /** Door ids that are online and trusted right now (never throws). */
  probe: () => Promise<readonly string[]>;
  /** Begin a residency at that Door (hello → Session.start → WS bind). */
  arrive: (doorId: string) => Promise<LiveResidency>;
  /** Boot preference, best first (e.g. the chain's last Door, then `CURRENT_DOOR_ID`). */
  bootPreference?: () => Promise<readonly string[]>;
  /** Boot arrival errors that must fail boot instead of being retried (default none). */
  isFatalBootError?: (error: unknown) => boolean;
  /** Uniform `[0, 1)` source for choosing the next Door (default `Math.random`). */
  random?: () => number;
  /** Travel when the residency is older than this; `0` disables the timer trigger. */
  maxResidencyMs: number;
  /** Timer-triggered departs form memories from this many lines (default 10). */
  minMemoryLines?: number;
  /** Residency-age check cadence (default 60 s). */
  ageCheckIntervalMs?: number;
  /** Backoff between depart attempts; attempts = length + 1 (default 30 s, 120 s). */
  departRetryDelaysMs?: readonly number[];
  /** First arrival retry delay, doubling up to {@link arriveRetryMaxMs} (default 5 s). */
  arriveRetryBaseMs?: number;
  /** Arrival retry ceiling (default 5 min). */
  arriveRetryMaxMs?: number;
  /** How long {@link ResidencyController.shutdown} waits for an in-flight cycle (default 5 s). */
  shutdownGraceMs?: number;
  nowMs: () => number;
  timer: Timer;
  sleep: AbortableSleep;
  logger: Pick<Logger, "info" | "warn" | "error">;
};

const DEFAULT_AGE_CHECK_MS = 60_000;
const DEFAULT_DEPART_RETRY_DELAYS_MS = [30_000, 120_000] as const;
const DEFAULT_ARRIVE_RETRY_BASE_MS = 5_000;
const DEFAULT_ARRIVE_RETRY_MAX_MS = 300_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/** Thrown internally when shutdown aborts a cycle step. */
class CycleAborted extends Error {
  constructor() {
    super("residency cycle aborted by shutdown");
    this.name = "CycleAborted";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Next Door: uniformly random among `available` excluding `current`; `current` itself
 * only when it is the only one available; `null` when none is.
 */
export function chooseNextDoor(
  available: readonly string[],
  current: string | null,
  random: () => number
): string | null {
  const others = available.filter((doorId) => doorId !== current);
  if (others.length === 0) {
    return available[0] ?? null;
  }
  const index = Math.min(others.length - 1, Math.floor(random() * others.length));
  return others[index] ?? null;
}

/**
 * Owns the daemon's live residency and runs the core loop **reside → depart → travel**:
 *
 * `cycle` = detach the session socket → choose the next Door (random online Door, never
 * the current one if another is available) → `Session.depart` (witnessed memories,
 * journal, departure + travel to that Door) with retries → arrive there (re-probing and
 * retrying with backoff, at any online Door, until it works).
 *
 * Triggers are external ({@link requestCycle}) plus the residency-age timer. At most one
 * cycle runs at a time; shutdown aborts waits and never re-arrives.
 */
export class ResidencyController {
  private readonly options: ResidencyControllerOptions;
  private readonly random: () => number;
  private live: LiveResidency | null = null;
  private arrivedAtMs = 0;
  private inFlight: Promise<CycleOutcome> | null = null;
  private shuttingDown = false;
  private readonly abort = new AbortController();
  private ageTimerId: unknown = null;

  constructor(options: ResidencyControllerOptions) {
    this.options = options;
    this.random = options.random ?? Math.random;
  }

  /** The current live residency, or `null` while traveling / after shutdown. */
  get current(): LiveResidency | null {
    return this.live;
  }

  /** True while a cycle is running. */
  get cycling(): boolean {
    return this.inFlight !== null;
  }

  /**
   * First arrival at boot: the first {@link ResidencyControllerOptions.bootPreference} Door
   * that is online, else a random online Door. With no Door online (or a failed arrival)
   * it retries with backoff — it never gives up, except on an
   * {@link ResidencyControllerOptions.isFatalBootError}. Arms the residency-age timer when
   * `maxResidencyMs > 0`.
   */
  async begin(): Promise<LiveResidency> {
    const preferences = (await this.options.bootPreference?.()) ?? [];
    const residency = await this.arriveWithRetry(
      (available, failures) =>
        (failures === 0 ? preferences.find((doorId) => available.includes(doorId)) : undefined) ??
        chooseNextDoor(available, null, this.random),
      true
    );
    this.live = residency;
    this.arrivedAtMs = this.options.nowMs();
    if (this.options.maxResidencyMs > 0) {
      this.ageTimerId = this.options.timer.setInterval(() => {
        this.checkResidencyAge();
      }, this.options.ageCheckIntervalMs ?? DEFAULT_AGE_CHECK_MS);
    }
    return residency;
  }

  /**
   * Timer trigger: start a cycle once the live residency is older than `maxResidencyMs`.
   * No-op when the timer is disabled, a cycle is running, or the daemon is stopping.
   */
  checkResidencyAge(): void {
    const max = this.options.maxResidencyMs;
    if (max <= 0 || this.live === null || this.inFlight !== null || this.shuttingDown) {
      return;
    }
    if (this.options.nowMs() - this.arrivedAtMs < max) {
      return;
    }
    void this.requestCycle("timer");
  }

  /**
   * Start a residency cycle (single-flight). Resolves with the outcome; never rejects.
   * A request while a cycle is running resolves `busy` immediately.
   */
  requestCycle(trigger: CycleTrigger): Promise<CycleOutcome> {
    if (this.shuttingDown) {
      return Promise.resolve({ kind: "shutting_down", trigger });
    }
    if (this.inFlight !== null) {
      this.options.logger.warn({ trigger }, "residency_cycle_busy");
      return Promise.resolve({ kind: "busy", trigger });
    }
    const run = this.runCycle(trigger)
      .catch((error: unknown): CycleOutcome => {
        // runCycle handles its own failures; this is a last-resort guard.
        this.options.logger.error({ trigger, err: errorMessage(error) }, "residency_cycle_crashed");
        return { kind: "aborted", trigger, fromEpoch: -1 };
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  /**
   * Stop triggers, abort any cycle wait (backoff, arrival retry), give an in-flight step up
   * to `shutdownGraceMs` to settle, then release the live residency without departure.
   * Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (this.ageTimerId !== null) {
      this.options.timer.clearInterval(this.ageTimerId);
      this.ageTimerId = null;
    }
    this.abort.abort();
    const inFlight = this.inFlight;
    if (inFlight !== null) {
      const graceMs = this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        inFlight.then(() => undefined),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
        })
      ]);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
    }
    const live = this.live;
    this.live = null;
    if (live !== null) {
      await live.close();
    }
  }

  private async runCycle(trigger: CycleTrigger): Promise<CycleOutcome> {
    const residency = this.live;
    if (residency === null) {
      // Only reachable mid-travel, which is inside a cycle (busy) — defensive.
      return { kind: "busy", trigger };
    }
    const fromDoor = residency.doorId;
    const fromEpoch = residency.epoch;
    this.options.logger.info(
      { trigger, doorId: fromDoor, epoch: fromEpoch },
      "residency_cycle_started"
    );
    try {
      // 1. Travel gap starts: no inbound reaches the departing session from here on.
      //    (A failed socket close is logged, not fatal: Session.depart stops the session
      //    first, so a straggler frame is rejected by the Session itself.)
      await this.bestEffort(() => residency.detach(), "residency_detach_failed", fromEpoch);

      // 2. Where next: a random online Door, never this one if another is online.
      this.throwIfShuttingDown();
      const available = await this.options.probe();
      const next = chooseNextDoor(available, fromDoor, this.random);
      this.options.logger.info({ fromDoor, toDoor: next, available }, "residency_next_door");

      // 3. Depart (retryable); after the last attempt, departure + travel without memories.
      const request: DepartRequest = {
        ...(next === null ? {} : { toDoorId: next }),
        minMemoryLines:
          trigger === "operator" ? 1 : (this.options.minMemoryLines ?? DEFAULT_MIN_MEMORY_LINES)
      };
      let departed: DepartResult | null = null;
      let departError: unknown = null;
      const delays = this.options.departRetryDelaysMs ?? DEFAULT_DEPART_RETRY_DELAYS_MS;
      for (let attempt = 0; ; attempt += 1) {
        this.throwIfShuttingDown();
        try {
          departed = await residency.depart(request);
          break;
        } catch (error: unknown) {
          const delay = delays[attempt];
          this.options.logger.warn(
            { epoch: fromEpoch, attempt: attempt + 1, err: errorMessage(error) },
            "residency_depart_failed"
          );
          if (delay === undefined) {
            departError = error;
            break;
          }
          await this.pause(delay);
        }
      }
      this.throwIfShuttingDown();

      if (departed === null) {
        this.options.logger.error(
          { epoch: fromEpoch, err: errorMessage(departError) },
          "residency_depart_abandoned"
        );
        try {
          await residency.departBare(next ?? undefined);
        } catch (error: unknown) {
          this.options.logger.warn(
            { epoch: fromEpoch, err: errorMessage(error) },
            "residency_depart_bare_failed"
          );
        }
      } else {
        this.options.logger.info({ epoch: fromEpoch, ...departed }, "residency_departed");
      }

      // The old residency is over either way.
      this.live = null;
      await this.bestEffort(() => residency.close(), "residency_close_failed", fromEpoch);

      // 4. Arrive at the chosen Door (any online Door if that keeps failing).
      const arrived = await this.arriveWithRetry(
        (online, failures) =>
          failures === 0 && next !== null && online.includes(next)
            ? next
            : chooseNextDoor(online, fromDoor, this.random),
        false
      );
      this.live = arrived;
      this.arrivedAtMs = this.options.nowMs();
      if (this.shuttingDown) {
        // Shutdown landed while arrival was in flight: release it (no departure).
        this.live = null;
        await arrived.close();
        throw new CycleAborted();
      }

      const outcome: CycleOutcome =
        departed === null
          ? {
              kind: "abandoned",
              trigger,
              fromDoor,
              toDoor: arrived.doorId,
              fromEpoch,
              toEpoch: arrived.epoch,
              error: errorMessage(departError)
            }
          : {
              kind: "cycled",
              trigger,
              fromDoor,
              toDoor: arrived.doorId,
              fromEpoch,
              toEpoch: arrived.epoch,
              witnessed: departed.witnessed,
              declined: departed.declined,
              journalPath: departed.journalPath
            };
      this.options.logger.info(outcome, "residency_cycle_outcome");
      return outcome;
    } catch (error: unknown) {
      if (error instanceof CycleAborted) {
        this.options.logger.warn({ trigger, epoch: fromEpoch }, "residency_cycle_aborted");
        return { kind: "aborted", trigger, fromEpoch };
      }
      throw error;
    }
  }

  /**
   * Arrive with capped exponential backoff until success or shutdown: probe, pick a Door
   * via `choose(online, failedArrivals)`, arrive. At boot, errors matching
   * `isFatalBootError` propagate.
   */
  private async arriveWithRetry(
    choose: (online: readonly string[], failures: number) => string | null,
    boot: boolean
  ): Promise<LiveResidency> {
    const base = this.options.arriveRetryBaseMs ?? DEFAULT_ARRIVE_RETRY_BASE_MS;
    const max = this.options.arriveRetryMaxMs ?? DEFAULT_ARRIVE_RETRY_MAX_MS;
    let delay = base;
    let failures = 0;
    for (let attempt = 1; ; attempt += 1) {
      this.throwIfShuttingDown();
      const online = await this.options.probe();
      this.throwIfShuttingDown();
      const doorId = choose(online, failures);
      if (doorId === null) {
        this.options.logger.warn({ attempt, retryInMs: delay }, "residency_no_door_available");
      } else {
        try {
          return await this.options.arrive(doorId);
        } catch (error: unknown) {
          if (boot && this.options.isFatalBootError?.(error) === true) {
            throw error;
          }
          failures += 1;
          this.options.logger.warn(
            { doorId, attempt, retryInMs: delay, err: errorMessage(error) },
            "residency_arrive_failed"
          );
        }
      }
      await this.pause(delay);
      delay = Math.min(delay * 2, max);
    }
  }

  /** Run a release step whose failure must not strand the Wanderer between Doors. */
  private async bestEffort(step: () => Promise<void>, msg: string, epoch: number): Promise<void> {
    try {
      await step();
    } catch (error: unknown) {
      this.options.logger.warn({ epoch, err: errorMessage(error) }, msg);
    }
  }

  /** Abortable wait; throws {@link CycleAborted} when shutdown aborts it. */
  private async pause(ms: number): Promise<void> {
    this.throwIfShuttingDown();
    try {
      await this.options.sleep(ms, this.abort.signal);
    } catch {
      // Sleep rejects only on abort.
    }
    this.throwIfShuttingDown();
  }

  private throwIfShuttingDown(): void {
    if (this.shuttingDown) {
      throw new CycleAborted();
    }
  }
}

/** Real-time {@link AbortableSleep} (resolves early, without throwing, on abort). */
export const abortableSleep: AbortableSleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(handle);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
