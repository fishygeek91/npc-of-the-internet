import { DaemonError } from "../daemon-errors.js";

/** Default directory the daemon polls for operator control requests (tmpfs in Ghost). */
export const DEFAULT_CONTROL_DIR = "/tmp/npc-control";

/** Default directory for residency journal markdown files (Ghost `published` volume). */
export const DEFAULT_JOURNAL_DIR = "/data/published/journals";

/** Default quarantine window (24 h) — same default as `loadQuarantineConfig`. */
export const DEFAULT_QUARANTINE_WINDOW_MS = 86_400_000;

/**
 * Smallest accepted `NPC_RESIDENCY_MAX_MS` (1 h). Every cycle costs a host review in
 * Discord and Brain calls; shorter residencies would also leave too little conversation
 * to distill 5+ shards.
 */
export const MIN_RESIDENCY_MAX_MS = 3_600_000;

/** Default `NPC_RESIDENCY_MIN_LINES`: the timer trigger waits for this much conversation. */
export const DEFAULT_TIMER_MIN_TRANSCRIPT_LINES = 10;

/** Smallest accepted `NPC_QUARANTINE_COMMIT_INTERVAL_MS` (10 s). */
export const MIN_COMMIT_INTERVAL_MS = 10_000;

/**
 * Largest `NPC_QUARANTINE_WINDOW_MS` accepted while the commit sweep is enabled (1 h).
 * The Door only co-signs commits for the epoch whose review it holds, and forgets that
 * review on the next arrival — so the Wanderer must wait out the window *between*
 * residencies (absent from its Door). A 24 h window would mean a 24 h absence.
 */
export const MAX_COMMIT_WINDOW_MS = 3_600_000;

/** Residency lifecycle configuration (all automatic behavior defaults off). */
export type ResidencyConfig = {
  /** `NPC_RESIDENCY_OPERATOR_TRIGGER`: SIGUSR2 + control-dir depart requests start a cycle. */
  operatorTrigger: boolean;
  /** `NPC_CONTROL_DIR`: directory polled for `wanderer depart` request files. */
  controlDir: string;
  /** `NPC_RESIDENCY_MAX_MS`: cycle once the residency is older than this; `0` = disabled. */
  maxResidencyMs: number;
  /**
   * `NPC_RESIDENCY_MIN_LINES`: the timer trigger skips (and re-checks later) while the
   * live transcript holds fewer lines — too little conversation cannot distill the 5
   * shards host review requires. The operator trigger only needs one line.
   */
  timerMinTranscriptLines: number;
  /** `NPC_JOURNAL_DIR`: where depart writes the residency journal markdown. */
  journalDir: string;
  /**
   * `NPC_QUARANTINE_COMMIT_INTERVAL_MS`: poll interval of the post-departure commit
   * sweep (between departure and re-arrival); `0` = disabled (candidates stay candidates).
   */
  commitIntervalMs: number;
  /** `NPC_QUARANTINE_WINDOW_MS`: how long a candidate ripens before it may commit. */
  quarantineWindowMs: number;
};

function parseFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  throw new DaemonError(`${name} must be 1/true or 0/false (got ${raw})`, "invalid_config", name);
}

/** Parse an optional non-negative integer; unset/empty → `fallback`. */
function parseNonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") {
    return fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new DaemonError(
      `${name} must be a non-negative integer (got ${raw})`,
      "invalid_config",
      name
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new DaemonError(`${name} is too large (got ${raw})`, "invalid_config", name);
  }
  return parsed;
}

function parsePath(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim() ?? "";
  return raw === "" ? fallback : raw;
}

/**
 * Load and validate the residency lifecycle configuration.
 *
 * Every trigger is **off** unless explicitly enabled: `NPC_RESIDENCY_OPERATOR_TRIGGER`
 * (default off), `NPC_RESIDENCY_MAX_MS` (default `0` = off, else ≥ 1 h; with
 * `NPC_RESIDENCY_MIN_LINES`, default 10) and
 * `NPC_QUARANTINE_COMMIT_INTERVAL_MS` (default `0` = off, else ≥ 10 s, and then
 * `NPC_QUARANTINE_WINDOW_MS` must be ≤ 1 h). Paths: `NPC_CONTROL_DIR`
 * (default `/tmp/npc-control`), `NPC_JOURNAL_DIR` (default `/data/published/journals`).
 */
export function loadResidencyConfig(env: NodeJS.ProcessEnv = process.env): ResidencyConfig {
  const operatorTrigger = parseFlag(env, "NPC_RESIDENCY_OPERATOR_TRIGGER");
  const controlDir = parsePath(env, "NPC_CONTROL_DIR", DEFAULT_CONTROL_DIR);
  const journalDir = parsePath(env, "NPC_JOURNAL_DIR", DEFAULT_JOURNAL_DIR);

  const maxResidencyMs = parseNonNegativeInt(env, "NPC_RESIDENCY_MAX_MS", 0);
  if (maxResidencyMs !== 0 && maxResidencyMs < MIN_RESIDENCY_MAX_MS) {
    throw new DaemonError(
      `NPC_RESIDENCY_MAX_MS must be 0 (disabled) or ≥ ${String(MIN_RESIDENCY_MAX_MS)} (got ${String(maxResidencyMs)})`,
      "invalid_config",
      "NPC_RESIDENCY_MAX_MS"
    );
  }

  const timerMinTranscriptLines = parseNonNegativeInt(
    env,
    "NPC_RESIDENCY_MIN_LINES",
    DEFAULT_TIMER_MIN_TRANSCRIPT_LINES
  );
  if (timerMinTranscriptLines < 1) {
    throw new DaemonError(
      "NPC_RESIDENCY_MIN_LINES must be ≥ 1",
      "invalid_config",
      "NPC_RESIDENCY_MIN_LINES"
    );
  }

  const commitIntervalMs = parseNonNegativeInt(env, "NPC_QUARANTINE_COMMIT_INTERVAL_MS", 0);
  if (commitIntervalMs !== 0 && commitIntervalMs < MIN_COMMIT_INTERVAL_MS) {
    throw new DaemonError(
      `NPC_QUARANTINE_COMMIT_INTERVAL_MS must be 0 (disabled) or ≥ ${String(MIN_COMMIT_INTERVAL_MS)} (got ${String(commitIntervalMs)})`,
      "invalid_config",
      "NPC_QUARANTINE_COMMIT_INTERVAL_MS"
    );
  }

  const quarantineWindowMs = parseNonNegativeInt(
    env,
    "NPC_QUARANTINE_WINDOW_MS",
    DEFAULT_QUARANTINE_WINDOW_MS
  );
  if (quarantineWindowMs <= 0) {
    throw new DaemonError(
      "NPC_QUARANTINE_WINDOW_MS must be a positive integer",
      "invalid_config",
      "NPC_QUARANTINE_WINDOW_MS"
    );
  }
  if (commitIntervalMs !== 0 && quarantineWindowMs > MAX_COMMIT_WINDOW_MS) {
    throw new DaemonError(
      `NPC_QUARANTINE_WINDOW_MS must be ≤ ${String(MAX_COMMIT_WINDOW_MS)} while NPC_QUARANTINE_COMMIT_INTERVAL_MS is set: the Wanderer waits out the window between residencies (see ops/RUNBOOK.md "Residency lifecycle")`,
      "invalid_config",
      "NPC_QUARANTINE_WINDOW_MS"
    );
  }

  return {
    operatorTrigger,
    controlDir,
    maxResidencyMs,
    timerMinTranscriptLines,
    journalDir,
    commitIntervalMs,
    quarantineWindowMs
  };
}
