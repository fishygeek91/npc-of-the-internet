import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePublicKey } from "@npc/osp-core";

import { SOUL } from "./fixed-keys.js";

export const TEST_GUILD_ID = "123456789012345678";
export const TEST_CHANNEL_ID = "987654321098765432";
export const TEST_OPERATOR_ID = "111222333444555666";
export const TEST_REVIEW_CHANNEL_ID = "222333444555666777";

const tempDirs: string[] = [];

/** Remove temp directories created during a test file run. */
export async function cleanupTempDirs(): Promise<void> {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write a raw 32-byte door private key file and return its path.
 */
export async function writeTempDoorKey(fillByte = 8): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "door-discord-test-"));
  tempDirs.push(dir);
  const keyPath = join(dir, "door.key");
  await writeFile(keyPath, new Uint8Array(32).fill(fillByte));
  return keyPath;
}

/**
 * Minimal valid env map for {@link loadDiscordDoorConfig}.
 */
export async function validDiscordDoorEnv(
  overrides: Record<string, string> = {}
): Promise<Record<string, string>> {
  const doorKeyPath = await writeTempDoorKey();
  return {
    DISCORD_BOT_TOKEN: "test-bot-token",
    DISCORD_GUILD_ID: TEST_GUILD_ID,
    DISCORD_CHANNEL_ID: TEST_CHANNEL_ID,
    DISCORD_OPERATOR_IDS: TEST_OPERATOR_ID,
    DOOR_KEY_PATH: doorKeyPath,
    SOUL_PUBLIC_KEY: encodePublicKey(SOUL.publicKey),
    ...overrides
  };
}
