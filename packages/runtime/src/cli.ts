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
  wanderer move <door-id>
  wanderer quarantine commit
  wanderer quarantine flag <candidate-cid> [--category <cat>]

depart: ask the running residency daemon (same container / host) to run one residency
  cycle — distill → host cosign review → journal → departure + travel → re-arrival at the
  next epoch. Requires NPC_RESIDENCY_OPERATOR_TRIGGER=1 on the daemon. Writes a request
  into the control dir (NPC_CONTROL_DIR, default /tmp/npc-control) and waits for the
  daemon to pick it up (exit 0) or times out (exit 1, request withdrawn). The cycle itself
  runs in the daemon: follow its logs for residency_cycle_outcome.

move / quarantine: v0.1 shell — without injected runMove / runQuarantineCommit /
runQuarantineFlag (tests) these commands exit 2 (the daemon runs commits itself when
NPC_QUARANTINE_COMMIT_INTERVAL_MS is set). Documented env names for those (not read
by this binary yet):
  SOUL_KEY_PATH              path to soul private key file
  SOULCHAIN_DIR              soulchain directory
  TRANSCRIPT_PATH            residency transcript JSONL
  JOURNAL_DIR                directory for emitted journal markdown
  CURRENT_DOOR_ID            door id of the active residency
  NPC_QUARANTINE_WINDOW_MS   quarantine window before commit (default 86400000)

Exit codes:
  0  success
  1  depart request not picked up by a running daemon
  2  usage or missing configuration
`;

/** Result printed after a successful `move` command. */
export type MoveCliResult = {
  journalPath: string;
  nextDoorId: string;
  nextEpoch: number;
};

/** Result printed after a successful `quarantine commit` command. */
export type CommitCliResult = {
  committedCount: number;
  ripeningCount: number;
};

/** Injectable dependencies for {@link runWandererCli} (tests inject handlers). */
export type WandererCliDeps = {
  /** Defaults to {@link requestDaemonDepart} (control-dir request to the running daemon). */
  runDepart?: (options: { controlDir: string; timeoutMs: number }) => Promise<boolean>;
  /** Environment for defaults such as `NPC_CONTROL_DIR` (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  runMove?: (doorId: string) => Promise<MoveCliResult>;
  runQuarantineCommit?: () => Promise<CommitCliResult>;
  runQuarantineFlag?: (candidateCid: string, category?: string) => Promise<void>;
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
              "(is NPC_RESIDENCY_OPERATOR_TRIGGER=1 set on the runtime?). Request withdrawn."
          );
          return EXIT_NOT_ACCEPTED;
        }
        writeStdout("Depart requested: the daemon accepted the request.");
        writeStdout(
          "Watch the host review in Discord and the runtime logs for residency_cycle_outcome."
        );
        return 0;
      }

      case "move": {
        const { positionals } = parseArgs({
          args: argv.slice(3),
          allowPositionals: true
        });

        const doorId = positionals[0];
        if (doorId === undefined) {
          usageError(writeStderr, "move requires a target door id");
        }

        // T4.1: wire production runMove from env + door-sdk/ws transport (env names in USAGE only today).
        if (deps.runMove === undefined) {
          usageError(
            writeStderr,
            "move is not configured: inject runMove in tests (production wiring is T4.1)"
          );
        }

        const result = await deps.runMove(doorId);
        writeStdout(`Journal: ${result.journalPath}`);
        writeStdout(`Arrived at ${result.nextDoorId} (epoch ${String(result.nextEpoch)})`);
        return 0;
      }

      case "quarantine": {
        const quarantineSubcommand = argv[3];
        if (quarantineSubcommand === undefined) {
          usageError(writeStderr, "quarantine requires a subcommand: commit | flag");
        }

        switch (quarantineSubcommand) {
          case "commit": {
            if (deps.runQuarantineCommit === undefined) {
              usageError(
                writeStderr,
                "quarantine commit is not configured: inject runQuarantineCommit in tests (production wiring is T4.1)"
              );
            }

            const result = await deps.runQuarantineCommit();
            writeStdout(`Committed ${String(result.committedCount)} shard(s)`);
            writeStdout(`Ripening ${String(result.ripeningCount)} candidate(s)`);
            return 0;
          }

          case "flag": {
            const { values, positionals } = parseArgs({
              args: argv.slice(4),
              options: {
                category: { type: "string" }
              },
              allowPositionals: true
            });

            const candidateCid = positionals[0];
            if (candidateCid === undefined) {
              usageError(writeStderr, "quarantine flag requires a candidate CID");
            }

            if (deps.runQuarantineFlag === undefined) {
              usageError(
                writeStderr,
                "quarantine flag is not configured: inject runQuarantineFlag in tests (production wiring is T4.1)"
              );
            }

            const category = values.category;
            await deps.runQuarantineFlag(
              candidateCid,
              typeof category === "string" ? category : undefined
            );
            writeStdout(`Flagged candidate ${candidateCid}`);
            return 0;
          }

          default:
            usageError(
              writeStderr,
              `unknown quarantine subcommand: ${quarantineSubcommand} (expected commit | flag)`
            );
        }
        break;
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
