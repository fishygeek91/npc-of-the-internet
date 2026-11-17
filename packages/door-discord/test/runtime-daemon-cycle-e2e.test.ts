/**
 * Full residency cycle, production wiring end to end: the REAL runtime daemon
 * (`startResidencyDaemon`, env-loaded config, `NPC_DOOR_URLS`) against TWO REAL
 * `startDiscordDoor` instances (HTTP + WebSocket servers, memory witness) with fake
 * Discord gateways and fake witnesses.
 *
 * Discord message at Door A → Wanderer reply → operator cycle → Door A's witness
 * co-signs the memories (no human) → departure + travel → arrival at Door B (epoch 2) →
 * presence notices on both → B's community talks to the Wanderer → chain verifies.
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
import {
  ARRIVED_NOTICE,
  MOVED_ON_NOTICE,
  startDiscordDoor,
  type DiscordDoorHandle
} from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { DOOR, DOOR_B, SOUL } from "./helpers/fixed-keys.js";
import {
  CHANNEL_ID,
  cleanupTempDirs,
  GUILD_ID,
  makeTempDir,
  testConfig,
  USER_ID
} from "./helpers/harness.js";

const GUILD_B = "10011";
const CHANNEL_B = "10012";

let daemon: ResidencyDaemonHandle | null = null;
const doorHandles: DiscordDoorHandle[] = [];

afterEach(async () => {
  await daemon?.shutdown();
  daemon = null;
  while (doorHandles.length > 0) {
    await doorHandles.pop()?.stop();
  }
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

describe("E2E runtime daemon <-> two Discord Doors: one full residency cycle", () => {
  it("reside at A → witnessed depart → travel → arrive at B (epoch 2); chain verifies", async () => {
    const root = await makeTempDir("daemon-cycle-");
    const doorIdA = doorIdForGuild(GUILD_ID);
    const doorIdB = doorIdForGuild(GUILD_B);
    const gatewayA = new FakeGateway();
    const gatewayB = new FakeGateway();
    const witnessedAt: string[] = [];

    const startDoor = async (
      gateway: FakeGateway,
      overrides: Parameters<typeof testConfig>[0]
    ): Promise<{ handle: DiscordDoorHandle; url: string }> => {
      const port = await freePort();
      const handle = await startDiscordDoor({
        config: await testConfig({
          httpHost: "127.0.0.1",
          httpPort: port,
          presenceNotices: true,
          ...overrides
        }),
        gateway,
        logger: pino({ level: "silent" }),
        witness: async (input) => {
          witnessedAt.push(`${input.doorId}:${input.kind}`);
          return { witnessed: true };
        }
      });
      doorHandles.push(handle);
      return { handle, url: `http://127.0.0.1:${String(port)}` };
    };

    const doorKeyB = join(root, "door-b.key");
    await writeFile(doorKeyB, Buffer.from(DOOR_B.privateKey));
    const a = await startDoor(gatewayA, {});
    const b = await startDoor(gatewayB, {
      guildId: GUILD_B,
      channelId: CHANNEL_B,
      doorKeyPath: doorKeyB
    });

    const chainDir = join(root, "chain");
    const soulKeyPath = join(root, "soul.key");
    await writeFile(soulKeyPath, encodeBase64Url(SOUL.privateKey), "utf8");
    const doorKeys = { [doorIdA]: DOOR.publicKey, [doorIdB]: DOOR_B.publicKey };
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
      NPC_DOOR_URLS: `${a.url},${b.url}`,
      CURRENT_DOOR_ID: doorIdA,
      ATLAS_DOOR_PUBKEYS: [
        `${doorIdA}=${encodePublicKey(DOOR.publicKey)}`,
        `${doorIdB}=${encodePublicKey(DOOR_B.publicKey)}`
      ].join(","),
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
    await waitFor(() => a.handle.status().present, "present at A");
    expect(b.handle.status().present).toBe(false);

    const say = async (
      gateway: FakeGateway,
      guildId: string,
      channelId: string,
      id: string,
      content: string
    ): Promise<void> => {
      await gateway.emitMessage({
        id,
        guildId,
        channelId,
        authorId: USER_ID,
        authorDisplay: "T",
        content,
        isBot: false,
        replyToId: undefined
      });
    };
    const replies = (gateway: FakeGateway): number =>
      gateway.sent.filter((message) => message.content === "glad to be here").length;

    await say(gatewayA, GUILD_ID, CHANNEL_ID, "20001", "hello wanderer");
    await waitFor(() => replies(gatewayA) === 1, "reply at A");

    const outcome: CycleOutcome = await handle.requestCycle("operator");
    expect(outcome).toMatchObject({
      kind: "cycled",
      fromDoor: doorIdA,
      toDoor: doorIdB,
      fromEpoch: 1,
      toEpoch: 2,
      witnessed: 5,
      declined: 0
    });
    // Only Door A witnessed: five shards and the journal.
    expect(witnessedAt).toEqual([
      ...Array.from({ length: 5 }, () => `${doorIdA}:shard`),
      `${doorIdA}:journal`
    ]);
    await waitFor(() => b.handle.status().present, "present at B");
    expect(a.handle.status().present).toBe(false);

    await say(gatewayB, GUILD_B, CHANNEL_B, "20002", "welcome");
    await waitFor(() => replies(gatewayB) === 1, "reply at B");

    const notices = (gateway: FakeGateway): string[] =>
      gateway.sent
        .map((message) => message.content)
        .filter((content) => content === ARRIVED_NOTICE || content === MOVED_ON_NOTICE);
    expect(notices(gatewayA)).toEqual([ARRIVED_NOTICE, MOVED_ON_NOTICE]);
    expect(notices(gatewayB)).toEqual([ARRIVED_NOTICE]);

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
      "shard",
      "shard",
      "shard",
      "shard",
      "shard",
      "journal",
      "departure:1",
      "travel:1",
      "arrival:2"
    ]);
    expect((await verifyChain(store, { doorPublicKeys: doorKeys })).valid).toBe(true);
    await store.close();
  });
});
