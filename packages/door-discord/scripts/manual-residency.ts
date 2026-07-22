#!/usr/bin/env node

/**
 * Ghost-era manual residency harness: live Discord + in-process Session.
 * Uses FakeBrain (no API key). See MANUAL_TEST.md.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRecord, encodePublicKey, FileSoulStore } from "@npc/osp-core";
import {
  FakeBrain,
  FileTranscriptSource,
  loadSoulPrivateKeyFromPath,
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
  const store = await FileSoulStore.open(chainDir, {
    doorPublicKeys: [doorKeypair.publicKey]
  });

  const head = await store.head();
  if (head === null) {
    const genesis = await createRecord({
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

  const doorId = doorIdForGuild(config.guildId);
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
    doorPublicKeys: [doorKeypair.publicKey]
  });

  logger.info({ doorId, status: handle.status() }, "arrived — chat in the bound channel");
  logger.info("Press Ctrl+C when ready to depart (approve candidate shards in Discord)");

  await new Promise<void>((resolve) => {
    const onStop = (): void => {
      process.off("SIGINT", onStop);
      resolve();
    };
    process.on("SIGINT", onStop);
  });

  const transcriptPath = join(chainDir, "transcript.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ role: "user", text: "What do you see here?" }),
      JSON.stringify({ role: "assistant", text: "A channel that will not keep me forever." }),
      JSON.stringify({ role: "user", text: "Will you remember us?" }),
      JSON.stringify({ role: "assistant", text: "Only if the host endorses the shards." }),
      JSON.stringify({ role: "user", text: "Safe travels." }),
      JSON.stringify({ role: "assistant", text: "And patience on the review." }),
      JSON.stringify({ role: "user", text: "Anything else?" }),
      JSON.stringify({ role: "assistant", text: "Gratitude for the noise and the silence." }),
      JSON.stringify({ role: "user", text: "Go well." }),
      JSON.stringify({ role: "assistant", text: "I leave as I arrived — curious." })
    ].join("\n") + "\n",
    "utf8"
  );

  const shardTexts = Array.from(
    { length: 5 },
    (_, i) => `I remember a brief stay and question ${String(i + 1)}.`
  );
  const distillBrain = new FakeBrain([
    JSON.stringify({ shards: shardTexts.map((text) => ({ text })) }),
    `# Leaving ${doorId}\n\nI remember the channel and the wait for host endorsement.\n`
  ]);

  logger.info("departing — approve or reject candidate shards in Discord (timeout rejects)");
  await session.depart({
    brain: distillBrain,
    transcript: new FileTranscriptSource(transcriptPath),
    journalDir: join(chainDir, "journals"),
    nextDoorId: "irc:manual-elsewhere"
  });

  logger.info({ chainDir }, "departed — run: osp verify --dir <SOULCHAIN_DIR>");
  await handle.stop();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
