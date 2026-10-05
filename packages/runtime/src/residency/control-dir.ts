import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Timer } from "../session/types.js";

/** File name of a pending operator depart request inside the control directory. */
export const DEPART_REQUEST_FILE = "depart.request";

/** Default poll interval for {@link watchControlDir} (1 s). */
export const DEFAULT_CONTROL_POLL_MS = 1_000;

/** Absolute path of the depart request file for `controlDir`. */
export function departRequestPath(controlDir: string): string {
  return path.join(path.resolve(controlDir), DEPART_REQUEST_FILE);
}

/**
 * Operator side (`wanderer depart`): atomically drop a depart request into `controlDir`
 * (temp file + rename, so the daemon never reads a half-written request). The file
 * holds only the request time — no secrets, no transcript. Returns the request path.
 */
export async function writeDepartRequest(controlDir: string, requestedAt: string): Promise<string> {
  const target = departRequestPath(controlDir);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${String(process.pid)}`;
  await writeFile(temp, `${JSON.stringify({ requested_at: requestedAt })}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temp, target);
  return target;
}

/**
 * Daemon side: consume a pending depart request. Returns `true` exactly once per
 * request (the file is unlinked — a request is never replayed), `false` when none is
 * pending. Request contents are informational only and never trusted.
 */
export async function consumeDepartRequest(controlDir: string): Promise<boolean> {
  const target = departRequestPath(controlDir);
  try {
    await unlink(target);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

/** True while a depart request file is still waiting to be consumed. */
export async function isDepartRequestPending(controlDir: string): Promise<boolean> {
  try {
    await readFile(departRequestPath(controlDir));
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

/** Remove an unconsumed depart request (operator CLI timeout cleanup). Idempotent. */
export async function withdrawDepartRequest(controlDir: string): Promise<void> {
  try {
    await unlink(departRequestPath(controlDir));
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

/** Options for {@link watchControlDir}. */
export type WatchControlDirOptions = {
  controlDir: string;
  timer: Timer;
  /** Poll interval (default {@link DEFAULT_CONTROL_POLL_MS}). */
  intervalMs?: number;
  /** Called once per consumed depart request. */
  onDepartRequest: () => void;
  /** Called when polling fails (e.g. the directory became unreadable). */
  onError?: (error: unknown) => void;
};

/** Handle returned by {@link watchControlDir}. */
export type ControlDirWatcher = {
  stop: () => void;
};

/**
 * Daemon side: create `controlDir` (mode 0700) and poll it for depart requests.
 * Polling (not `fs.watch`) keeps behavior identical on tmpfs, overlayfs and bind mounts.
 * A stale request left in the directory before the daemon started is consumed too —
 * Ghost mounts the control dir on tmpfs, so a container restart clears it.
 */
export async function watchControlDir(options: WatchControlDirOptions): Promise<ControlDirWatcher> {
  await mkdir(path.resolve(options.controlDir), { recursive: true, mode: 0o700 });
  let polling = false;
  let stopped = false;
  const id = options.timer.setInterval(() => {
    if (polling || stopped) {
      return;
    }
    polling = true;
    void consumeDepartRequest(options.controlDir)
      .then((consumed) => {
        if (consumed && !stopped) {
          options.onDepartRequest();
        }
      })
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        polling = false;
      });
  }, options.intervalMs ?? DEFAULT_CONTROL_POLL_MS);
  return {
    stop: () => {
      stopped = true;
      options.timer.clearInterval(id);
    }
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Options for {@link requestDaemonDepart}. */
export type RequestDaemonDepartOptions = {
  controlDir: string;
  /** How long to wait for the daemon to pick the request up (default 15 s). */
  timeoutMs?: number;
  /** Poll interval while waiting (default 200 ms). */
  pollMs?: number;
  /** Wall clock (ISO) for the request stamp. */
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Operator side of `wanderer depart`: drop a depart request and wait until the running
 * daemon consumes it. Returns `true` when picked up. On timeout the request is withdrawn
 * (so a daemon enabled later never acts on a stale request) and `false` is returned —
 * usually the daemon is not running or `NPC_RESIDENCY_OPERATOR_TRIGGER` is off.
 * Pick-up means *accepted*, not *done*: the cycle (host review included) runs in the
 * daemon; follow its logs for `residency_cycle_outcome`.
 */
export async function requestDaemonDepart(options: RequestDaemonDepartOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const now = options.now ?? ((): string => new Date().toISOString());
  await writeDepartRequest(options.controlDir, now());
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    if (!(await isDepartRequestPending(options.controlDir))) {
      return true;
    }
  }
  if (!(await isDepartRequestPending(options.controlDir))) {
    return true;
  }
  await withdrawDepartRequest(options.controlDir);
  return false;
}
