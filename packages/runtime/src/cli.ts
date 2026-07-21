#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Exit code for usage or configuration errors. */
export const EXIT_USAGE = 2;

const USAGE = `wanderer — NPC of the Internet operator CLI

Usage:
  wanderer move <door-id>

Production wiring (Ghost v0.1) is env-based and not yet implemented in-process.
Required env (documented for operators; inject deps in tests):
  SOUL_KEY_PATH       path to soul private key file
  SOULCHAIN_DIR       soulchain directory
  TRANSCRIPT_PATH     residency transcript JSONL
  JOURNAL_DIR         directory for emitted journal markdown
  CURRENT_DOOR_ID     door id of the active residency

Exit codes:
  0  success
  2  usage or missing configuration
`;

/** Result printed after a successful `move` command. */
export type MoveCliResult = {
  journalPath: string;
  nextDoorId: string;
  nextEpoch: number;
};

/** Injectable dependencies for {@link runWandererCli} (tests and future production wiring). */
export type WandererCliDeps = {
  runMove?: (doorId: string) => Promise<MoveCliResult>;
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
      case "move": {
        const { positionals } = parseArgs({
          args: argv.slice(3),
          allowPositionals: true
        });

        const doorId = positionals[0];
        if (doorId === undefined) {
          usageError(writeStderr, "move requires a target door id");
        }

        if (deps.runMove === undefined) {
          usageError(
            writeStderr,
            "move is not configured: set operator env vars or inject runMove in tests"
          );
        }

        const result = await deps.runMove(doorId);
        writeStdout(`Journal: ${result.journalPath}`);
        writeStdout(`Arrived at ${result.nextDoorId} (epoch ${String(result.nextEpoch)})`);
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
