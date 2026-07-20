#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { initExitCode, runInit } from "./commands/init.js";
import { runLog } from "./commands/log.js";
import { runShow } from "./commands/show.js";
import { EXIT_USAGE, runVerify } from "./commands/verify.js";
import { writeStderr, writeStdout } from "./io.js";

const USAGE = `osp — OpenSoul Protocol CLI

Usage:
  osp init <dir> [--charter <path>]
  osp verify <dir> [--door-key <base64url>]...
  osp log <dir>
  osp show <cid> --dir <dir>

Exit codes:
  0  success / chain valid
  1  chain verification failed
  2  usage or I/O error
`;

/** Print usage text to stderr and exit with code 2. */
function usageError(message?: string): never {
  if (message !== undefined) {
    writeStderr(message);
  }
  writeStderr(USAGE);
  process.exit(EXIT_USAGE);
}

/** Handle unexpected errors with exit code 2. */
function fatalError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  writeStderr(message);
  process.exit(EXIT_USAGE);
}

/** Parse repeatable --door-key flags from verify argv. */
function parseDoorKeys(values: { "door-key"?: string | string[] }): string[] {
  const raw = values["door-key"];
  if (raw === undefined) {
    return [];
  }
  return Array.isArray(raw) ? raw : [raw];
}

/** Entry point for the osp CLI binary. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const subcommand = argv[2];
  if (subcommand === undefined) {
    usageError();
  }

  try {
    switch (subcommand) {
      case "init": {
        const { positionals, values } = parseArgs({
          args: argv.slice(3),
          options: {
            charter: { type: "string" }
          },
          allowPositionals: true
        });

        const dir = positionals[0];
        if (dir === undefined) {
          usageError("init requires a target directory");
        }

        const initOptions: { dir: string; charterPath?: string } = { dir };
        if (values.charter !== undefined) {
          initOptions.charterPath = values.charter;
        }

        const result = await runInit(initOptions);
        writeStdout(`Soul public key: ${result.publicKey}`);
        writeStdout(`Genesis CID: ${result.genesisCid}`);
        process.exit(0);
        break;
      }

      case "verify": {
        const { positionals, values } = parseArgs({
          args: argv.slice(3),
          options: {
            "door-key": { type: "string", multiple: true }
          },
          allowPositionals: true
        });

        const dir = positionals[0];
        if (dir === undefined) {
          usageError("verify requires a soulchain directory");
        }

        const exitCode = await runVerify({
          dir,
          doorKeys: parseDoorKeys(values)
        });
        process.exit(exitCode);
        break;
      }

      case "log": {
        const { positionals } = parseArgs({
          args: argv.slice(3),
          allowPositionals: true
        });

        const dir = positionals[0];
        if (dir === undefined) {
          usageError("log requires a soulchain directory");
        }

        await runLog(dir);
        process.exit(0);
        break;
      }

      case "show": {
        const { positionals, values } = parseArgs({
          args: argv.slice(3),
          options: {
            dir: { type: "string" }
          },
          allowPositionals: true
        });

        const cid = positionals[0];
        if (cid === undefined) {
          usageError("show requires a record CID");
        }

        const dir = values.dir;
        if (dir === undefined) {
          usageError("show requires --dir <soulchain-directory>");
        }

        await runShow({ dir, cid });
        process.exit(0);
        break;
      }

      case "--help":
      case "-h":
      case "help":
        writeStdout(USAGE);
        process.exit(0);
        break;

      default:
        usageError(`unknown command: ${subcommand}`);
    }
  } catch (error) {
    if (subcommand === "init") {
      if (error instanceof Error) {
        writeStderr(error.message);
      }
      process.exit(initExitCode(error));
    }
    if (subcommand === "verify" && error instanceof Error) {
      writeStderr(error.message);
      process.exit(EXIT_USAGE);
    }
    fatalError(error);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(fatalError);
}
