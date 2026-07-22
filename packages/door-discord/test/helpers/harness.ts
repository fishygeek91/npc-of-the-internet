import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRecord, encodePublicKey } from "@npc/osp-core";

import type { DiscordDoorConfig } from "../../src/config.js";
import { APPROVE_EMOJI } from "../../src/review-gate.js";
import type { FakeGateway } from "./fake-gateway.js";
import { DOOR, SOUL } from "./fixed-keys.js";
import { MemorySoulStore } from "./memory-soul-store.js";

export const GUILD_ID = "123456789012345678";
export const CHANNEL_ID = "234567890123456789";
export const OTHER_CHANNEL_ID = "345678901234567890";
export const OPERATOR_ID = "111222333444555666";
export const USER_ID = "999888777666555444";

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
    reviewTimeoutMs: 5_000,
    userRatePerMinute: 100,
    userBurst: 20,
    channelRatePerMinute: 200,
    channelBurst: 40,
    communityName: "Test Guild",
    communityDescription: "Integration test community",
    ...overrides
  };
}

/** Genesis + empty MemorySoulStore. */
export async function genesisStore(): Promise<MemorySoulStore> {
  const store = new MemorySoulStore();
  const genesis = await createRecord({
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

/**
 * While `depart` awaits cosign review, approve every posted review message.
 * Stops when `done` resolves or after maxAttempts.
 */
export async function autoApproveReviews(
  gateway: FakeGateway,
  done: Promise<unknown>,
  maxAttempts = 400
): Promise<void> {
  const seen = new Set<string>();
  let finished = false;
  void done.finally(() => {
    finished = true;
  });

  for (let attempt = 0; attempt < maxAttempts && !finished; attempt += 1) {
    for (const msg of gateway.sent) {
      if (!msg.content.includes("**Cosign review**") || seen.has(msg.id)) {
        continue;
      }
      seen.add(msg.id);
      await gateway.emitReaction({
        messageId: msg.id,
        channelId: msg.channelId,
        userId: OPERATOR_ID,
        emoji: APPROVE_EMOJI
      });
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
