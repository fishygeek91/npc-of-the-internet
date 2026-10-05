import type { Logger } from "pino";

import type { CommitQuarantineResult } from "../quarantine/commit.js";
import type { DepartResult } from "../session/session.js";
import type { Timer } from "../session/types.js";
import { MAX_COMMIT_WINDOW_MS } from "./config.js";

/** What started a residency cycle. */
export type CycleTrigger = "operator" | "timer";

/**
 * Outcome of {@link ResidencyController.requestCycle}.
 *
 * - `cycled`: departed (distill → review → records → journal) and re-arrived at `toEpoch`.
 * - `abandoned`: depart kept failing; the residency was dropped without departure
 *   records (same chain shape as a crash) and the Wanderer re-arrived at `toEpoch`.
 * - `skipped`: nothing to distill yet (transcript below the trigger's minimum).
 * - `busy`: another cycle is already running (single-flight).
 * - `shutting_down`: the daemon is stopping; no cycle started.
 * - `aborted`: shutdown interrupted the cycle; no re-arrival (next boot re-arrives).
 */
export type CycleOutcome =
  | {
      kind: "cycled";
      trigger: CycleTrigger;
      fromEpoch: number;
      toEpoch: number;
      candidateCount: number;
      committedCount: number;
      journalPath: string;
    }
  | { kind: "abandoned"; trigger: CycleTrigger; fromEpoch: number; toEpoch: number; error: string }
  | { kind: "skipped"; trigger: CycleTrigger; reason: "transcript_too_short"; lines: number }
  | { kind: "busy"; trigger: CycleTrigger }
  | { kind: "shutting_down"; trigger: CycleTrigger }
  | { kind: "aborted"; trigger: CycleTrigger; fromEpoch: number };

/** One live residency (Session + its Door session socket) as seen by the controller. */
export interface LiveResidency {
  /** Global residency epoch. */
  readonly epoch: number;
  /** Lines currently held by the live in-memory transcript. */
  transcriptSize(): number;
  /**
   * Stop delivering Door session traffic to this residency (close its WebSocket client;
   * later inbound frames are dropped). Idempotent.
   */
  detach(): Promise<void>;
  /** End the residency via `Session.depart` (retryable after a mid-pipeline failure). */
  depart(): Promise<DepartResult>;
  /** Release without departure (shutdown): stop heartbeats, drain appends, detach. */
  close(): Promise<void>;
  /**
   * The Door advertised `cosign.past_epochs` in this residency's `hello`: it retains
   * completed reviews per epoch, so past epochs' candidates can be committed while this
   * residency is live. Absent/false = legacy Door (commits only in the travel gap).
   */
  readonly pastEpochCommits?: boolean;
  /** Run `fn` serialized with this residency's chain appends (heartbeats). */
  withAppendLock?<T>(fn: () => Promise<T>): Promise<T>;
}

/** Commit hook: promote the departed epoch's ripe candidates (scoped to that residency). */
export type CommitDepartedEpoch = (args: {
  epoch: number;
  journalMarkdown?: string;
}) => Promise<CommitQuarantineResult>;

/**
 * Live commit hook: promote every ripe candidate of this Door's past epochs (the Door
 * advertised `cosign.past_epochs`). Runs on a timer while a residency is live.
 */
export type CommitPendingEpochs = () => Promise<CommitQuarantineResult>;

/** Abortable sleep; must reject (or resolve) promptly when `signal` aborts. */
export type AbortableSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Options for {@link ResidencyController}. */
export type ResidencyControllerOptions = {
  /** Begin a residency at the Door (Session.start + WS bind). */
  arrive: () => Promise<LiveResidency>;
  /**
   * Travel-gap commit sweep for a legacy Door (no `cosign.past_epochs`): runs between
   * departure and re-arrival, only while `quarantineWindowMs` ≤ {@link MAX_COMMIT_WINDOW_MS}.
   * Omit to disable (candidates stay candidates).
   */
  commit?: CommitDepartedEpoch;
  /**
   * Live commit sweep for a Door that advertises `cosign.past_epochs`: every
   * `commitIntervalMs` while a residency is live (serialized with its appends).
   */
  commitPending?: CommitPendingEpochs;
  /** Interval of the commit sweeps (required when `commit` or `commitPending` is set). */
  commitIntervalMs?: number;
  /** Quarantine window; bounds the travel-gap sweep (window + 5 polls). */
  quarantineWindowMs?: number;
  /** Cycle when the residency is older than this; `0` disables the timer trigger. */
  maxResidencyMs: number;
  /** Timer trigger skips residencies with fewer transcript lines (default 10). */
  timerMinTranscriptLines?: number;
  /** Residency-age check cadence (default 60 s). */
  ageCheckIntervalMs?: number;
  /** Backoff between depart attempts; attempts = length + 1 (default 30 s, 120 s). */
  departRetryDelaysMs?: readonly number[];
  /** First re-arrival retry delay, doubling up to {@link arriveRetryMaxMs} (default 5 s). */
  arriveRetryBaseMs?: number;
  /** Re-arrival retry ceiling (default 5 min). */
  arriveRetryMaxMs?: number;
  /** Consecutive commit-sweep failures before giving up (default 3). */
  commitMaxFailures?: number;
  /** How long {@link ResidencyController.shutdown} waits for an in-flight cycle (default 5 s). */
  shutdownGraceMs?: number;
  nowMs: () => number;
  timer: Timer;
  sleep: AbortableSleep;
  logger: Pick<Logger, "info" | "warn" | "error">;
};

const DEFAULT_TIMER_MIN_LINES = 10;
const DEFAULT_AGE_CHECK_MS = 60_000;
const DEFAULT_DEPART_RETRY_DELAYS_MS = [30_000, 120_000] as const;
const DEFAULT_ARRIVE_RETRY_BASE_MS = 5_000;
const DEFAULT_ARRIVE_RETRY_MAX_MS = 300_000;
const DEFAULT_COMMIT_MAX_FAILURES = 3;
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
 * Owns the daemon's live residency and runs the core loop
 * **reside → distill → publish → move** at the same Door:
 *
 * `cycle` = detach the session socket → `Session.depart` (distill the live transcript,
 * host cosign review, candidate/rejected records, journal, departure + travel
 * attestations) → [legacy Door only: commit sweep of the departed epoch while
 * traveling] → `Session.start` at the next epoch (re-arrival supersedes nothing: the
 * Door retired the old epoch at departure and accepts `epoch > lastKnownEpoch`).
 *
 * With a Door that advertises `cosign.past_epochs`, quarantined candidates are instead
 * committed by a **live sweep** (`commitPending`, every `commitIntervalMs`) while the
 * next residency is live, so the quarantine window does not keep the Wanderer away.
 *
 * Triggers are external ({@link requestCycle}) plus an optional residency-age timer.
 * At most one cycle runs at a time; shutdown aborts waits and never re-arrives.
 */
export class ResidencyController {
  private readonly options: ResidencyControllerOptions;
  private live: LiveResidency | null = null;
  private arrivedAtMs = 0;
  private inFlight: Promise<CycleOutcome> | null = null;
  private shuttingDown = false;
  private readonly abort = new AbortController();
  private ageTimerId: unknown = null;
  private liveSweepTimerId: unknown = null;
  private liveSweepRunning: Promise<void> | null = null;
  private timerSkipLogged = false;

  constructor(options: ResidencyControllerOptions) {
    if (
      (options.commit !== undefined || options.commitPending !== undefined) &&
      (options.commitIntervalMs ?? 0) <= 0
    ) {
      throw new Error("ResidencyController: commitIntervalMs must be > 0 when commit is set");
    }
    this.options = options;
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
   * First arrival at boot (errors propagate — boot fails as before). Arms the
   * residency-age timer only when `maxResidencyMs > 0`.
   */
  async begin(): Promise<LiveResidency> {
    const residency = await this.options.arrive();
    this.live = residency;
    this.arrivedAtMs = this.options.nowMs();
    this.armLiveSweep(residency);
    if (this.options.maxResidencyMs > 0) {
      this.ageTimerId = this.options.timer.setInterval(() => {
        this.checkResidencyAge();
      }, this.options.ageCheckIntervalMs ?? DEFAULT_AGE_CHECK_MS);
    }
    return residency;
  }

  /**
   * Timer trigger: start a cycle once the live residency is older than
   * `maxResidencyMs` and its transcript holds enough lines to distill. No-op when the
   * timer is disabled, a cycle is running, or the daemon is stopping.
   */
  checkResidencyAge(): void {
    const max = this.options.maxResidencyMs;
    const live = this.live;
    if (max <= 0 || live === null || this.inFlight !== null || this.shuttingDown) {
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
   * Stop triggers, abort any cycle wait (backoff, commit sweep, re-arrival retry), give
   * an in-flight step up to `shutdownGraceMs` to settle, then release the live residency
   * without departure. Idempotent.
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
    this.disarmLiveSweep();
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
    const fromEpoch = residency.epoch;
    const lines = residency.transcriptSize();
    const minLines =
      trigger === "timer" ? (this.options.timerMinTranscriptLines ?? DEFAULT_TIMER_MIN_LINES) : 1;
    if (lines < minLines) {
      if (trigger !== "timer" || !this.timerSkipLogged) {
        this.options.logger.info(
          { trigger, epoch: fromEpoch, lines, minLines },
          "residency_cycle_skipped"
        );
      }
      if (trigger === "timer") {
        this.timerSkipLogged = true;
      }
      return { kind: "skipped", trigger, reason: "transcript_too_short", lines };
    }

    this.options.logger.info({ trigger, epoch: fromEpoch, lines }, "residency_cycle_started");
    // No live sweep while traveling; an in-flight one is drained by depart (append queue).
    this.disarmLiveSweep();
    try {
      // 1. Travel gap starts: no inbound reaches the departing session from here on.
      //    (A failed socket close is logged, not fatal: Session.depart stops the session
      //    first, so a straggler frame is rejected by the Session itself.)
      await this.bestEffort(() => residency.detach(), "residency_detach_failed", fromEpoch);

      // 2. Depart (retryable per Bug #69); abandon after the last attempt.
      let departed: DepartResult | null = null;
      let departError: unknown = null;
      const delays = this.options.departRetryDelaysMs ?? DEFAULT_DEPART_RETRY_DELAYS_MS;
      for (let attempt = 0; ; attempt += 1) {
        this.throwIfShuttingDown();
        try {
          departed = await residency.depart();
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

      // The old residency is over either way (departed, or abandoned crash-style).
      this.live = null;
      await this.bestEffort(() => residency.close(), "residency_close_failed", fromEpoch);

      let committedCount = 0;
      if (departed !== null) {
        this.options.logger.info(
          {
            epoch: fromEpoch,
            approved: departed.approvedShardIds.length,
            rejected: departed.rejectedShardIds.length,
            candidates: departed.candidateCids.length,
            journalPath: departed.journalPath
          },
          "residency_departed"
        );
        if (departed.candidateCids.length > 0) {
          committedCount = await this.travelGapCommit(residency, fromEpoch, departed);
        }
      } else {
        this.options.logger.error(
          { epoch: fromEpoch, err: errorMessage(departError) },
          "residency_depart_abandoned"
        );
      }

      // 3. Re-arrive at the same Door (next epoch).
      const next = await this.arriveWithRetry();
      this.live = next;
      this.arrivedAtMs = this.options.nowMs();
      this.timerSkipLogged = false;
      if (this.shuttingDown) {
        // Shutdown landed while arrival was in flight: release it (no departure).
        this.live = null;
        await next.close();
        throw new CycleAborted();
      }
      this.armLiveSweep(next);
      this.options.logger.info(
        { trigger, fromEpoch, toEpoch: next.epoch, committed: committedCount },
        "residency_cycle_complete"
      );
      if (departed === null) {
        return {
          kind: "abandoned",
          trigger,
          fromEpoch,
          toEpoch: next.epoch,
          error: errorMessage(departError)
        };
      }
      return {
        kind: "cycled",
        trigger,
        fromEpoch,
        toEpoch: next.epoch,
        candidateCount: departed.candidateCids.length,
        committedCount,
        journalPath: departed.journalPath
      };
    } catch (error: unknown) {
      if (error instanceof CycleAborted) {
        this.options.logger.warn({ trigger, epoch: fromEpoch }, "residency_cycle_aborted");
        return { kind: "aborted", trigger, fromEpoch };
      }
      throw error;
    }
  }

  /**
   * Decide the departed epoch's commit path. A Door with `cosign.past_epochs` keeps the
   * review across the next arrival, so nothing runs here: the live sweep of the next
   * residency commits the candidates once they ripen (the default 24 h window works).
   * A legacy Door forgets the review on arrival, so its candidates can only be committed
   * now — and only while the window is short (≤ {@link MAX_COMMIT_WINDOW_MS}); otherwise
   * they stay candidates. Returns the number of shards committed.
   */
  private async travelGapCommit(
    residency: LiveResidency,
    epoch: number,
    departed: DepartResult
  ): Promise<number> {
    if (residency.pastEpochCommits === true && this.options.commitPending !== undefined) {
      this.options.logger.info(
        { epoch, candidates: departed.candidateCids.length },
        "residency_commit_deferred_to_live_sweep"
      );
      return 0;
    }
    if (this.options.commit === undefined) {
      return 0;
    }
    const windowMs = this.options.quarantineWindowMs ?? 0;
    if (windowMs > MAX_COMMIT_WINDOW_MS) {
      this.options.logger.error(
        { epoch, quarantineWindowMs: windowMs, maxTravelGapWindowMs: MAX_COMMIT_WINDOW_MS },
        "residency_commit_sweep_unsupported"
      );
      return 0;
    }
    return this.commitSweep(epoch, departed);
  }

  /** Start the live commit sweep timer for `residency` when its Door supports it. */
  private armLiveSweep(residency: LiveResidency): void {
    this.disarmLiveSweep();
    const commitPending = this.options.commitPending;
    const intervalMs = this.options.commitIntervalMs ?? 0;
    if (commitPending === undefined || intervalMs <= 0 || residency.pastEpochCommits !== true) {
      return;
    }
    this.liveSweepTimerId = this.options.timer.setInterval(() => {
      this.runLiveSweep(residency);
    }, intervalMs);
    this.options.logger.info({ epoch: residency.epoch, intervalMs }, "residency_live_sweep_armed");
  }

  private disarmLiveSweep(): void {
    if (this.liveSweepTimerId !== null) {
      this.options.timer.clearInterval(this.liveSweepTimerId);
      this.liveSweepTimerId = null;
    }
  }

  /**
   * One live sweep tick: commit ripe candidates of past epochs, serialized with the live
   * residency's appends. Skips while a cycle runs, a sweep is still running, or the
   * residency is no longer live. Failures are logged and retried on the next tick.
   */
  private runLiveSweep(residency: LiveResidency): void {
    const commitPending = this.options.commitPending;
    if (
      commitPending === undefined ||
      this.shuttingDown ||
      this.inFlight !== null ||
      this.live !== residency ||
      this.liveSweepRunning !== null
    ) {
      return;
    }
    const run = (
      residency.withAppendLock !== undefined
        ? residency.withAppendLock(commitPending)
        : commitPending()
    )
      .then((result) => {
        if (result.committedCids.length > 0 || result.strandedCids.length > 0) {
          this.options.logger.info(
            {
              epoch: residency.epoch,
              committed: result.committedCids.length,
              ripening: result.ripeningCids.length,
              stranded: result.strandedCids.length,
              journalAttached: result.journalAttached
            },
            "residency_live_commit_sweep"
          );
        }
      })
      .catch((error: unknown) => {
        this.options.logger.warn(
          { epoch: residency.epoch, err: errorMessage(error) },
          "residency_live_commit_sweep_failed"
        );
      })
      .finally(() => {
        this.liveSweepRunning = null;
      });
    this.liveSweepRunning = run;
  }

  /**
   * Commit sweep for the departed epoch at a legacy Door, run **between departure and
   * re-arrival** — the only time such a Door still holds that epoch's review.
   * Polls until no candidate is ripening, the bound (window + 5 polls) passes, or
   * `commitMaxFailures` consecutive sweeps fail. Returns the number of shards committed.
   */
  private async commitSweep(epoch: number, departed: DepartResult): Promise<number> {
    const commit = this.options.commit;
    const intervalMs = this.options.commitIntervalMs ?? 0;
    if (commit === undefined || intervalMs <= 0) {
      return 0;
    }
    const maxFailures = this.options.commitMaxFailures ?? DEFAULT_COMMIT_MAX_FAILURES;
    const deadline = this.options.nowMs() + (this.options.quarantineWindowMs ?? 0) + intervalMs * 5;
    let committed = 0;
    let journalPending = true;
    let failures = 0;
    this.options.logger.info(
      { epoch, candidates: departed.candidateCids.length, intervalMs },
      "residency_commit_sweep_started"
    );
    for (;;) {
      await this.pause(intervalMs);
      try {
        const result = await commit({
          epoch,
          ...(journalPending ? { journalMarkdown: departed.journalMarkdown } : {})
        });
        failures = 0;
        committed += result.committedCids.length;
        if (result.journalAttached) {
          journalPending = false;
        }
        this.options.logger.info(
          {
            epoch,
            committed: result.committedCids.length,
            ripening: result.ripeningCids.length,
            journalAttached: result.journalAttached
          },
          "residency_commit_sweep"
        );
        if (result.ripeningCids.length === 0) {
          return committed;
        }
      } catch (error: unknown) {
        failures += 1;
        this.options.logger.warn(
          { epoch, failures, err: errorMessage(error) },
          "residency_commit_sweep_failed"
        );
        if (failures >= maxFailures) {
          this.options.logger.error({ epoch, committed }, "residency_commit_sweep_abandoned");
          return committed;
        }
      }
      if (this.options.nowMs() >= deadline) {
        this.options.logger.warn({ epoch, committed }, "residency_commit_sweep_deadline");
        return committed;
      }
    }
  }

  /** Re-arrive with capped exponential backoff until success or shutdown. */
  private async arriveWithRetry(): Promise<LiveResidency> {
    const base = this.options.arriveRetryBaseMs ?? DEFAULT_ARRIVE_RETRY_BASE_MS;
    const max = this.options.arriveRetryMaxMs ?? DEFAULT_ARRIVE_RETRY_MAX_MS;
    let delay = base;
    for (let attempt = 1; ; attempt += 1) {
      this.throwIfShuttingDown();
      try {
        return await this.options.arrive();
      } catch (error: unknown) {
        this.options.logger.warn(
          { attempt, retryInMs: delay, err: errorMessage(error) },
          "residency_arrive_failed"
        );
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
