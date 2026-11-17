import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OSP_SPEC_V02, createRecord, encodePublicKey } from "@npc/osp-core";

import type { DiscordDoorConfig } from "../../src/config.js";
import { DOOR, SOUL } from "./fixed-keys.js";
import { MemorySoulStore } from "./memory-soul-store.js";

/** Short fake snowflakes — long digit runs trip gitleaks `discord-client-id`. */
export const GUILD_ID = "10001";
export const CHANNEL_ID = "10002";
export const OTHER_CHANNEL_ID = "10003";
export const OPERATOR_ID = "10004";
export const USER_ID = "10005";

const tempDirs: string[] = [];

/** Track temp dirs for afterEach cleanup. */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write the test door private key to a temp file; return path + config fragment. */
export async function writeDoorKeyFile(): Promise<string> {
  const dir = await makeTempDir("door-discord-key-");
  const path = join(dir, "door.key");
  await writeFile(path, Buffer.from(DOOR.privateKey));
  return path;
}

/** Build a DiscordDoorConfig for tests (real key path required). */
export async function testConfig(
  overrides: Partial<DiscordDoorConfig> = {}
): Promise<DiscordDoorConfig> {
  const doorKeyPath = overrides.doorKeyPath ?? (await writeDoorKeyFile());
  return {
    botToken: "test-bot-token",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    operatorIds: [OPERATOR_ID],
    doorKeyPath,
    soulPublicKey: SOUL.publicKey,
    httpHost: "127.0.0.1",
    httpPort: 9090,
    userRatePerMinute: 100,
    userBurst: 20,
    channelRatePerMinute: 200,
    channelBurst: 40,
    communityName: "Test Guild",
    communityDescription: "Integration test community",
    presenceNotices: false,
    witness: null,
    ...overrides
  };
}

/** Genesis + empty MemorySoulStore. */
export async function genesisStore(): Promise<MemorySoulStore> {
  const store = new MemorySoulStore();
  const genesis = await createRecord({
    spec: OSP_SPEC_V02,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nI travel the doors.",
      soul_pubkey: encodePublicKey(SOUL.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: SOUL.privateKey
  });
  await store.append(genesis.record);
  return store;
}
