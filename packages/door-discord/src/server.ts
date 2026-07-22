#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import pino from "pino";

import { loadDiscordDoorConfig } from "./config.js";
import { DiscordDoorError } from "./errors.js";
import { startDiscordDoor } from "./start.js";

/**
 * Production entrypoint: load env config and start the Discord Door adapter.
 */
export async function main(): Promise<void> {
  const logger = pino({ name: "door-discord" });
  try {
    const config = loadDiscordDoorConfig();
    const handle = await startDiscordDoor({ config, logger });
    logger.info({ doorId: handle.doorId }, "discord_door_started");

    const shutdown = (): void => {
      void handle.stop().then(() => {
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error: unknown) {
    if (error instanceof DiscordDoorError) {
      logger.error({ code: error.code, err: error.message }, "boot_failed");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message }, "boot_failed");
    }
    process.exit(1);
  }
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  void main();
}
