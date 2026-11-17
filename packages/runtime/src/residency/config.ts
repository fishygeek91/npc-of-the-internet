import { DaemonError } from "../daemon-errors.js";
import { DEFAULT_MIN_MEMORY_LINES } from "../session/session.js";

/** Default directory the daemon polls for operator control requests (tmpfs in Ghost). */
export const DEFAULT_CONTROL_DIR = "/tmp/npc-control";

/** Default directory for residency journal markdown files (Ghost `published` volume). */
export const DEFAULT_JOURNAL_DIR = "/data/published/journals";

/** Default `NPC_RESIDENCY_MAX_MS`: travel about once a day. */
export const DEFAULT_MAX_RESIDENCY_MS = 86_400_000;

/** Smallest accepted non-zero `NPC_RESIDENCY_MAX_MS` (1 h). */
export const MIN_RESIDENCY_MAX_MS = 3_600_000;

/** Residency lifecycle configuration. */
export type ResidencyConfig = {
  /** `NPC_RESIDENCY_OPERATOR_TRIGGER`: SIGUSR2 + control-dir depart requests start a cycle. */
  operatorTrigger: boolean;
  /** `NPC_CONTROL_DIR`: directory polled for `wanderer depart` request files. */
  controlDir: string;
  /** `NPC_RESIDENCY_MAX_MS`: travel once the residency is older than this; `0` = never. */
  maxResidencyMs: number;
  /**
   * `NPC_RESIDENCY_MIN_LINES`: a timer-triggered departure forms memories only when the
   * stay's transcript holds at least this many lines (a quiet stay still travels).
   * Operator-requested departures need one line.
   */
  minMemoryLines: number;
  /** `NPC_JOURNAL_DIR`: where depart writes witnessed residency journals. */
  journalDir: string;
};

/** Parse a boolean flag; unset/empty → `fallback`. */
function parseFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase() ?? "";
  if (raw === "") {
    return fallback;
  }
  if (raw === "0" || raw === "false") {
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
 * - `NPC_RESIDENCY_MAX_MS` — travel timer, default `86400000` (a day); `0` disables, else
 *   ≥ `3600000`.
 * - `NPC_RESIDENCY_MIN_LINES` — default `10`, ≥ 1: fewer lines form no memories.
 * - `NPC_RESIDENCY_OPERATOR_TRIGGER` — default on; `0` disables SIGUSR2 / `wanderer depart`.
 * - `NPC_CONTROL_DIR` (default `/tmp/npc-control`), `NPC_JOURNAL_DIR`
 *   (default `/data/published/journals`).
 */
export function loadResidencyConfig(env: NodeJS.ProcessEnv = process.env): ResidencyConfig {
  const operatorTrigger = parseFlag(env, "NPC_RESIDENCY_OPERATOR_TRIGGER", true);
  const controlDir = parsePath(env, "NPC_CONTROL_DIR", DEFAULT_CONTROL_DIR);
  const journalDir = parsePath(env, "NPC_JOURNAL_DIR", DEFAULT_JOURNAL_DIR);

  const maxResidencyMs = parseNonNegativeInt(env, "NPC_RESIDENCY_MAX_MS", DEFAULT_MAX_RESIDENCY_MS);
  if (maxResidencyMs !== 0 && maxResidencyMs < MIN_RESIDENCY_MAX_MS) {
    throw new DaemonError(
      `NPC_RESIDENCY_MAX_MS must be 0 (disabled) or ≥ ${String(MIN_RESIDENCY_MAX_MS)} (got ${String(maxResidencyMs)})`,
      "invalid_config",
      "NPC_RESIDENCY_MAX_MS"
    );
  }

  const minMemoryLines = parseNonNegativeInt(
    env,
    "NPC_RESIDENCY_MIN_LINES",
    DEFAULT_MIN_MEMORY_LINES
  );
  if (minMemoryLines < 1) {
    throw new DaemonError(
      "NPC_RESIDENCY_MIN_LINES must be ≥ 1",
      "invalid_config",
      "NPC_RESIDENCY_MIN_LINES"
    );
  }

  return { operatorTrigger, controlDir, maxResidencyMs, minMemoryLines, journalDir };
}
