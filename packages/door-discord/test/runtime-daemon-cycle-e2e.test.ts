/**
 * Full residency cycle, production wiring end to end: the REAL runtime daemon
 * (`startResidencyDaemon`, env-loaded config) against the REAL `startDiscordDoor`
 * (HTTP + WebSocket servers, `ReviewGatedDoor`) with a fake Discord gateway.
 *
 * Discord message → Wanderer reply → operator cycle → cosign review posted to Discord
 * and approved by reaction → candidates + departure + travel → re-arrival at epoch 2 →
 * the community talks to the new residency → chain verifies with the Door key.
 */
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  OSP_SPEC_V02,
  createRecord,
  encodeBase64Url,
  encodePublicKey,
  FileSoulStore,
  verifyChain
} from "@npc/osp-core";
import {
  FakeBrain,
  loadDaemonConfig,
  startResidencyDaemon,
  type CycleOutcome,
  type ResidencyDaemonHandle
} from "@npc/runtime";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { startDiscordDoor, type DiscordDoorHandle } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import {
  autoApproveReviews,
  CHANNEL_ID,
  cleanupTempDirs,
  GUILD_ID,
  makeTempDir,
  testConfig,
  USER_ID
} from "./helpers/harness.js";

let daemon: ResidencyDaemonHandle | null = null;
let doorHandle: DiscordDoorHandle | null = null;

afterEach(async () => {
  await daemon?.shutdown();
  daemon = null;
  await doorHandle?.stop();
  doorHandle = null;
  await cleanupTempDirs();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const SHARDS_JSON = JSON.stringify({
  shards: Array.from({ length: 5 }, (_, i) => ({
    text: `I remember the Discord evening, moment ${String(i + 1)}.`
  }))
});

describe("E2E runtime daemon <-> door-discord: one full residency cycle", () => {
  it("reside → distill → Discord review → depart → re-arrive at epoch 2; chain verifies", async () => {
    const port = await freePort();
    const gateway = new FakeGateway();
    const doorId = doorIdForGuild(GUILD_ID);
    doorHandle = await startDiscordDoor({
      config: await testConfig({ httpHost: "127.0.0.1", httpPort: port, reviewTimeoutMs: 10_000 }),
      gateway,
      logger: pino({ level: "silent" })
    });

    const root = await makeTempDir("daemon-cycle-");
    const chainDir = join(root, "chain");
    const soulKeyPath = join(root, "soul.key");
    await writeFile(soulKeyPath, encodeBase64Url(SOUL.privateKey), "utf8");
    const doorKeys = { [doorId]: DOOR.publicKey };
    const seed = await FileSoulStore.open(chainDir, { doorPublicKeys: doorKeys });
    const genesis = await createRecord({
      spec: OSP_SPEC_V02,
      seq: 0,
      prev: null,
      type: "genesis",
      body: {
        charter: "# Wanderer\n\nI travel the doors.",
        soul_pubkey: encodePublicKey(SOUL.publicKey),
        created_at: "2026-10-01T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      soulPrivateKey: SOUL.privateKey
    });
    await seed.append(genesis.record);
    await seed.close();

    const config = loadDaemonConfig({
      SOUL_KEY_PATH: soulKeyPath,
      SOULCHAIN_DIR: chainDir,
      DOOR_HTTP_HOST: "127.0.0.1",
      DOOR_HTTP_PORT: String(port),
      CURRENT_DOOR_ID: doorId,
      ATLAS_DOOR_PUBKEYS: `${doorId}=${encodePublicKey(DOOR.publicKey)}`,
      ANTHROPIC_API_KEY: "unused-fake-brain-injected",
      NPC_ATTENTION_MODE: "always",
      NPC_RUNTIME_READY_FILE: join(root, "ready"),
      NPC_RESIDENCY_OPERATOR_TRIGGER: "1",
      NPC_CONTROL_DIR: join(root, "control"),
      NPC_JOURNAL_DIR: join(root, "published", "journals")
    });

    // Route by the user turn: distiller and journal prompts end with fixed instructions.
    const brain = new FakeBrain(async (messages) => {
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      if (user.includes("Distill this residency")) return SHARDS_JSON;
      if (user.includes("Write your residency journal")) {
        return "# Journal\n\nI left the channel humming.";
      }
      return "glad to be here";
    });

    daemon = await startResidencyDaemon(config, {
      brain,
      logger: pino({ level: "silent" }),
      skipSignals: true
    });
    const handle = daemon;
    expect(handle.currentEpoch()).toBe(1);
    await waitFor(() => doorHandle?.status().present === true, "door present");

    const say = async (id: string, content: string): Promise<void> => {
      await gateway.emitMessage({
        id,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        authorId: USER_ID,
        authorDisplay: "T",
        content,
        isBot: false,
        replyToId: undefined
      });
    };
    const replies = (): number =>
      gateway.sent.filter((message) => message.content === "glad to be here").length;

    await say("20001", "hello wanderer");
    await waitFor(() => replies() === 1, "reply in epoch 1");

    // Operator cycle; the host approves every review post by reaction.
    const cycle: Promise<CycleOutcome> = handle.requestCycle("operator");
    await autoApproveReviews(
      gateway,
      cycle.then(() => undefined)
    );
    const outcome = await cycle;
    expect(outcome).toMatchObject({ kind: "cycled", fromEpoch: 1, toEpoch: 2, candidateCount: 5 });
    expect(
      gateway.sent.filter((message) => message.content.includes("**Cosign review**"))
    ).toHaveLength(5);
    expect(doorHandle.door.getActiveEpoch()).toBe(2);

    await waitFor(() => doorHandle?.status().present === true, "present again");
    await say("20002", "welcome back");
    await waitFor(() => replies() === 2, "reply in epoch 2");

    await handle.shutdown();
    daemon = null;

    const store = await FileSoulStore.open(chainDir, { doorPublicKeys: doorKeys });
    const kinds: string[] = [];
    for await (const record of store.iterate()) {
      if (record.type === "attestation") {
        const body = record.body as { kind: string; epoch?: number; from_epoch?: number };
        kinds.push(`${body.kind}:${String(body.epoch ?? body.from_epoch)}`);
      } else if (record.type === "memory") {
        kinds.push(record.body.kind);
      }
    }
    expect(kinds).toEqual([
      "arrival:1",
      "candidate",
      "candidate",
      "candidate",
      "candidate",
      "candidate",
      "departure:1",
      "travel:1",
      "arrival:2"
    ]);
    expect((await verifyChain(store, { doorPublicKeys: doorKeys })).valid).toBe(true);
    await store.close();
  });
});
