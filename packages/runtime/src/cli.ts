#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_CONTROL_DIR } from "./residency/config.js";
import { requestDaemonDepart } from "./residency/control-dir.js";

/** Exit code for usage or configuration errors. */
export const EXIT_USAGE = 2;

/** Exit code when the running daemon did not pick up an operator request. */
export const EXIT_NOT_ACCEPTED = 1;

const USAGE = `wanderer — NPC of the Internet operator CLI

Usage:
  wanderer depart [--control-dir <dir>] [--timeout-ms <ms>]

depart: ask the running residency daemon (same container / host) to end this residency
  now and travel — witnessed memories → journal → departure + travel → arrival at the
  next Door. The operator trigger is on by default (NPC_RESIDENCY_OPERATOR_TRIGGER=0 turns
  it off). Writes a request into the control dir (NPC_CONTROL_DIR, default
  /tmp/npc-control) and waits for the daemon to pick it up (exit 0) or times out (exit 1,
  request withdrawn). The cycle itself runs in the daemon: follow its logs for
  residency_cycle_outcome.

Exit codes:
  0  success
  1  depart request not picked up by a running daemon
  2  usage or missing configuration
`;

/** Injectable dependencies for {@link runWandererCli} (tests inject handlers). */
export type WandererCliDeps = {
  /** Defaults to {@link requestDaemonDepart} (control-dir request to the running daemon). */
  runDepart?: (options: { controlDir: string; timeoutMs: number }) => Promise<boolean>;
  /** Environment for defaults such as `NPC_CONTROL_DIR` (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
};

function defaultWriteStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultWriteStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function usageError(writeStderr: (line: string) => void, message?: string): never {
  if (message !== undefined) {
    writeStderr(message);
  }
  writeStderr(USAGE);
  throw new WandererCliUsageError();
}

/** Thrown by {@link runWandererCli} on usage or configuration errors. */
export class WandererCliUsageError extends Error {
  constructor() {
    super("wanderer CLI usage error");
    this.name = "WandererCliUsageError";
  }
}

/**
 * Entry point for the wanderer CLI binary.
 * Returns process exit code; does not call `process.exit` (test-friendly).
 */
export async function runWandererCli(
  argv: readonly string[] = process.argv,
  deps: WandererCliDeps = {}
): Promise<number> {
  const writeStdout = deps.writeStdout ?? defaultWriteStdout;
  const writeStderr = deps.writeStderr ?? defaultWriteStderr;

  const subcommand = argv[2];
  if (subcommand === undefined) {
    usageError(writeStderr);
  }

  try {
    switch (subcommand) {
      case "depart": {
        const { values, positionals } = parseArgs({
          args: argv.slice(3),
          options: {
            "control-dir": { type: "string" },
            "timeout-ms": { type: "string" }
          },
          allowPositionals: true
        });
        if (positionals.length > 0) {
          usageError(writeStderr, "depart takes no positional arguments");
        }
        const env = deps.env ?? process.env;
        const envDir = env.NPC_CONTROL_DIR?.trim() ?? "";
        const controlDir = values["control-dir"] ?? (envDir === "" ? DEFAULT_CONTROL_DIR : envDir);
        const timeoutRaw = values["timeout-ms"] ?? "15000";
        if (!/^\d+$/u.test(timeoutRaw) || Number.parseInt(timeoutRaw, 10) <= 0) {
          usageError(writeStderr, `--timeout-ms must be a positive integer (got ${timeoutRaw})`);
        }
        const timeoutMs = Number.parseInt(timeoutRaw, 10);
        const runDepart = deps.runDepart ?? requestDaemonDepart;
        const accepted = await runDepart({ controlDir, timeoutMs });
        if (!accepted) {
          writeStderr(
            `No running daemon picked up the depart request in ${controlDir} within ${String(timeoutMs)} ms ` +
              "(is the daemon running with NPC_RESIDENCY_OPERATOR_TRIGGER on?). Request withdrawn."
          );
          return EXIT_NOT_ACCEPTED;
        }
        writeStdout("Depart requested: the daemon accepted the request.");
        writeStdout("Watch the runtime logs for residency_cycle_outcome.");
        return 0;
      }

      case "--help":
      case "-h":
      case "help":
        writeStdout(USAGE);
        return 0;

      default:
        usageError(writeStderr, `unknown command: ${subcommand}`);
    }
  } catch (error) {
    if (error instanceof WandererCliUsageError) {
      return EXIT_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(message);
    return EXIT_USAGE;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runWandererCli().then((code) => {
    process.exit(code);
  });
}
