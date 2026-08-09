#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runExportCar } from "./commands/export-car.js";
import { runInit } from "./commands/init.js";
import { runLog } from "./commands/log.js";
import { runManifest } from "./commands/manifest.js";
import { runMigrate } from "./commands/migrate.js";
import { runShow } from "./commands/show.js";
import { EXIT_USAGE, runVerify } from "./commands/verify.js";
import { runVerifyFromIpfs } from "./commands/verify-from-ipfs.js";
import { writeStderr, writeStdout } from "./io.js";

const USAGE = `osp — OpenSoul Protocol CLI

Usage:
  osp init <dir> [--charter <path>]
  osp migrate --to osp/0.2 <dir> [--door-private-key <doorId=base64url>]... [--door-key <doorId=base64url>]...
  osp verify <dir> [--door-key <doorId=base64url>]...
  osp verify --from-ipfs <head-cid> [--gateway <url>] [--door-key <doorId=base64url>]...
  osp manifest <dir> [--soul-key <path>] [--generated-at <iso>] [--prev-manifest <cid>]
  osp export-car <dir> --out <path> [--soul-key <path>] [--generated-at <iso>] [--prev-manifest <cid>]
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

      case "migrate": {
        const { positionals, values } = parseArgs({
          args: argv.slice(3),
          options: {
            to: { type: "string" },
            "door-private-key": { type: "string", multiple: true },
            "door-key": { type: "string", multiple: true }
          },
          allowPositionals: true
        });

        const dir = positionals[0];
        if (dir === undefined) {
          usageError("migrate requires a soulchain directory");
        }
        if (values.to === undefined) {
          usageError("migrate requires --to osp/0.2");
        }

        const doorPrivateRaw = values["door-private-key"];
        const doorPrivateKeys =
          doorPrivateRaw === undefined
            ? undefined
            : Array.isArray(doorPrivateRaw)
              ? doorPrivateRaw
              : [doorPrivateRaw];
        const doorPublicRaw = values["door-key"];
        const doorPublicKeys =
          doorPublicRaw === undefined
            ? undefined
            : Array.isArray(doorPublicRaw)
              ? doorPublicRaw
              : [doorPublicRaw];

        await runMigrate({
          dir,
          to: values.to,
          ...(doorPrivateKeys === undefined ? {} : { doorPrivateKeys }),
          ...(doorPublicKeys === undefined ? {} : { doorPublicKeys })
        });
        process.exit(0);
        break;
      }

      case "verify": {
        const { positionals, values } = parseArgs({
          args: argv.slice(3),
          options: {
            "door-key": { type: "string", multiple: true },
            "from-ipfs": { type: "boolean", default: false },
            gateway: { type: "string" }
          },
          allowPositionals: true
        });

        if (values["from-ipfs"] === true) {
          const headCid = positionals[0];
          if (headCid === undefined) {
            usageError("verify --from-ipfs requires a head CID");
          }

          const fromIpfsOptions: {
            headCid: string;
            doorKeys: string[];
            gatewayUrl?: string;
          } = {
            headCid,
            doorKeys: parseDoorKeys(values)
          };
          if (values.gateway !== undefined) {
            fromIpfsOptions.gatewayUrl = values.gateway;
          }

          const exitCode = await runVerifyFromIpfs(fromIpfsOptions);
          process.exit(exitCode);
          break;
        }

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

      case "manifest": {
        const { positionals, values } = parseArgs({
          args: argv.slice(3),
          options: {
            "soul-key": { type: "string" },
            "generated-at": { type: "string" },
            "prev-manifest": { type: "string" }
          },
          allowPositionals: true
        });

        const dir = positionals[0];
        if (dir === undefined) {
          usageError("manifest requires an IpfsSoulStore directory");
        }

        const manifestOptions: {
          dir: string;
          soulKeyPath?: string;
          generatedAt?: string;
          prevManifestCid?: string;
        } = { dir };
        if (values["soul-key"] !== undefined) {
          manifestOptions.soulKeyPath = values["soul-key"];
        }
        if (values["generated-at"] !== undefined) {
          manifestOptions.generatedAt = values["generated-at"];
        }
        if (values["prev-manifest"] !== undefined) {
          manifestOptions.prevManifestCid = values["prev-manifest"];
        }

        await runManifest(manifestOptions);
        process.exit(0);
        break;
      }

      case "export-car": {
        const { positionals, values } = parseArgs({
          args: argv.slice(3),
          options: {
            out: { type: "string" },
            "soul-key": { type: "string" },
            "generated-at": { type: "string" },
            "prev-manifest": { type: "string" }
          },
          allowPositionals: true
        });

        const dir = positionals[0];
        if (dir === undefined) {
          usageError("export-car requires an IpfsSoulStore directory");
        }
        if (values.out === undefined) {
          usageError("export-car requires --out <path>");
        }

        const exportOptions: {
          dir: string;
          out: string;
          soulKeyPath?: string;
          generatedAt?: string;
          prevManifestCid?: string;
        } = { dir, out: values.out };
        if (values["soul-key"] !== undefined) {
          exportOptions.soulKeyPath = values["soul-key"];
        }
        if (values["generated-at"] !== undefined) {
          exportOptions.generatedAt = values["generated-at"];
        }
        if (values["prev-manifest"] !== undefined) {
          exportOptions.prevManifestCid = values["prev-manifest"];
        }

        await runExportCar(exportOptions);
        process.exit(0);
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
    if (
      subcommand === "init" ||
      subcommand === "migrate" ||
      subcommand === "manifest" ||
      subcommand === "export-car" ||
      subcommand === "verify"
    ) {
      if (error instanceof Error) {
        writeStderr(error.message);
      }
      process.exit(EXIT_USAGE);
    }
    fatalError(error);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(fatalError);
}
