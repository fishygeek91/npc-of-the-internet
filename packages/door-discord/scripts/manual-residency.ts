#!/usr/bin/env node

/**
 * Ghost-era manual residency harness: live Discord + in-process Session.
 * Uses FakeBrain for the Wanderer (no Brain key); memories are judged by the Door's real
 * AI witness (`DOOR_WITNESS_*` / `NPC_BRAIN_*`). See MANUAL_TEST.md.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { OSP_SPEC_V02, createRecord, encodePublicKey, FileSoulStore } from "@npc/osp-core";
import {
  FakeBrain,
  loadSoulPrivateKeyFromPath,
  ResidencyTranscript,
  Session,
  SingleKeyKeyring
} from "@npc/runtime";
import pino from "pino";

import { doorIdForGuild, loadDiscordDoorConfig } from "../src/config.js";
import { loadDoorKeypairFromPath } from "../src/load-door-key.js";
import { startDiscordDoor } from "../src/start.js";

async function main(): Promise<void> {
  const logger = pino({ name: "door-discord-manual" });
  const config = loadDiscordDoorConfig();
  const soulKeyPath = process.env.SOUL_KEY_PATH;
  if (soulKeyPath === undefined || soulKeyPath === "") {
    throw new Error("SOUL_KEY_PATH is required for manual-residency");
  }
  const chainDir = process.env.SOULCHAIN_DIR ?? "./soulchain-data-manual";
  await mkdir(chainDir, { recursive: true });

  const soulPrivateKey = loadSoulPrivateKeyFromPath(soulKeyPath);
  const keyring = new SingleKeyKeyring(soulPrivateKey);
  const doorKeypair = loadDoorKeypairFromPath(config.doorKeyPath);
  const doorId = doorIdForGuild(config.guildId);
  const store = await FileSoulStore.open(chainDir, {
    doorPublicKeys: { [doorId]: doorKeypair.publicKey }
  });

  const head = await store.head();
  if (head === null) {
    const genesis = await createRecord({
      spec: OSP_SPEC_V02,
      seq: 0,
      prev: null,
      type: "genesis",
      body: {
        charter: "# Wanderer\n\nManual residency harness.",
        soul_pubkey: encodePublicKey(keyring.getSoulPublicKey()),
        created_at: new Date().toISOString()
      },
      residency: null,
      cosigners: [],
      soulPrivateKey
    });
    await store.append(genesis.record);
    logger.info("wrote genesis");
  }

  let session: Session | null = null;

  const handle = await startDiscordDoor({
    config,
    logger,
    disableServers: true,
    sessionBridge: {
      handleInbound: async (frame) => {
        if (session === null) {
          return null;
        }
        const result = await session.handleInbound(frame);
        return result.ok ? result.outbound : null;
      }
    }
  });

  const brain = new FakeBrain([
    "I am here in this channel for a little while.",
    "Ask me something before I have to leave.",
    "The door will close; that is the design."
  ]);

  const intervalHandles = new Map<number, ReturnType<typeof setInterval>>();
  let nextIntervalId = 1;

  session = await Session.start({
    store,
    door: handle.connection,
    doorId,
    keyring,
    brain,
    clock: { now: () => new Date().toISOString() },
    timer: {
      setInterval: (handler, ms) => {
        const id = nextIntervalId;
        nextIntervalId += 1;
        intervalHandles.set(id, setInterval(handler, ms));
        return id;
      },
      clearInterval: (id) => {
        if (typeof id !== "number") {
          return;
        }
        const handleId = intervalHandles.get(id);
        if (handleId !== undefined) {
          clearInterval(handleId);
          intervalHandles.delete(id);
        }
      }
    },
    doorPublicKeys: { [doorId]: doorKeypair.publicKey },
    transcript: new ResidencyTranscript(),
    witnessesMemories: handle.door.witnessesMemories()
  });

  logger.info({ doorId, status: handle.status() }, "arrived — chat in the bound channel");
  logger.info("Press Ctrl+C when ready to depart (the Door's witness judges the memories)");

  await new Promise<void>((resolve) => {
    const onStop = (): void => {
      process.off("SIGINT", onStop);
      resolve();
    };
    process.on("SIGINT", onStop);
  });

  // Canned shards: the witness co-signs only what the channel's record supports.
  const shardTexts = Array.from(
    { length: 5 },
    (_, i) => `I remember a brief stay and question ${String(i + 1)}.`
  );
  const distillBrain = new FakeBrain([
    JSON.stringify({ shards: shardTexts.map((text) => ({ text })) }),
    `# Leaving ${doorId}\n\nI remember the channel and the people who spoke to me.\n`
  ]);

  logger.info("departing — the Door's witness decides each memory");
  const departed = await session.depart({
    brain: distillBrain,
    journalDir: join(chainDir, "journals"),
    toDoorId: "irc:manual-elsewhere",
    minMemoryLines: 1
  });

  logger.info({ chainDir, ...departed }, "departed — run: osp verify --dir <SOULCHAIN_DIR>");
  await handle.stop();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
