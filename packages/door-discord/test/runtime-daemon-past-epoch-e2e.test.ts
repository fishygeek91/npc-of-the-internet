/**
 * Per-epoch cosign review retention, production wiring end to end: the REAL runtime
 * daemon against the REAL `startDiscordDoor` with `DOOR_STATE_DIR` persistence.
 *
 * Residency 1 is reviewed in Discord and departs → the Wanderer re-arrives at epoch 2
 * at once (no travel-gap wait) → door-discord restarts (review state reloaded from its
 * state dir) → a day later the daemon's live commit sweep promotes epoch 1's candidates
 * through the restarted Door, signed with epoch 1's session key → chain verifies.
 */
import { createServer } from "node:net";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { COSIGN_STATE_FILE } from "@npc/door-sdk";
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
import { FakeTimer } from "./helpers/fake-timer.js";
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

/** Real wall clock plus a test-controlled offset (Door, review gate, rate limits, daemon). */
class OffsetClock {
  offsetMs = 0;
  nowMs(): number {
    return Date.now() + this.offsetMs;
  }
  now(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

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

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const SHARDS_JSON = JSON.stringify({
  shards: Array.from({ length: 5 }, (_, i) => ({
    text: `I remember the Discord night, moment ${String(i + 1)}.`
  }))
});

describe("E2E runtime daemon <-> door-discord: past-epoch commits survive a Door restart", () => {
  it("re-arrive at epoch 2, restart door-discord, live sweep commits epoch 1 a day later", async () => {
    const port = await freePort();
    const clock = new OffsetClock();
    const stateDir = join(await makeTempDir("door-state-"), "door-state");
    const doorConfig = await testConfig({
      httpHost: "127.0.0.1",
      httpPort: port,
      reviewTimeoutMs: 10_000,
      stateDir
    });
    const doorId = doorIdForGuild(GUILD_ID);
    const gateway = new FakeGateway();
    doorHandle = await startDiscordDoor({
      config: doorConfig,
      gateway,
      clock,
      logger: pino({ level: "silent" })
    });

    const root = await makeTempDir("daemon-past-epoch-");
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

    // Production defaults: 24 h quarantine window, sweep on a timer while live.
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
      NPC_CONTROL_DIR: join(root, "control"),
      NPC_JOURNAL_DIR: join(root, "published", "journals"),
      NPC_QUARANTINE_COMMIT_INTERVAL_MS: "30000"
    });
    expect(config.residency.quarantineWindowMs).toBe(86_400_000);

    const brain = new FakeBrain(async (messages) => {
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      if (user.includes("Distill this residency")) return SHARDS_JSON;
      if (user.includes("Write your residency journal")) {
        return "# Journal\n\nThe night was long and kind.";
      }
      return "glad to be here";
    });
    const timer = new FakeTimer();
    daemon = await startResidencyDaemon(config, {
      brain,
      timer,
      clock,
      logger: pino({ level: "silent" }),
      skipSignals: true
    });
    const handle = daemon;
    await waitFor(() => doorHandle?.status().present === true, "door present");
    await gateway.emitMessage({
      id: "30001",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "T",
      content: "hello wanderer",
      isBot: false,
      replyToId: undefined
    });
    await waitFor(
      () => gateway.sent.some((message) => message.content === "glad to be here"),
      "reply in epoch 1"
    );

    const cycle: Promise<CycleOutcome> = handle.requestCycle("operator");
    await autoApproveReviews(
      gateway,
      cycle.then(() => undefined)
    );
    expect(await cycle).toMatchObject({
      kind: "cycled",
      fromEpoch: 1,
      toEpoch: 2,
      candidateCount: 5,
      committedCount: 0
    });
    expect(doorHandle.door.getActiveEpoch()).toBe(2);
    expect(await readdir(stateDir)).toContain(COSIGN_STATE_FILE);

    // door-discord restarts (e.g. image upgrade); its review state comes back from disk.
    await doorHandle.stop();
    doorHandle = await startDiscordDoor({
      config: doorConfig,
      gateway: new FakeGateway(),
      clock,
      logger: pino({ level: "silent" })
    });
    expect(doorHandle.door.getRetainedReviewEpochs()).toEqual([1]);

    const shardLines = async (): Promise<number> =>
      (await readFile(join(chainDir, "chain.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.includes('"kind":"shard"')).length;

    clock.offsetMs = 24 * 60 * 60 * 1000 + 60_000;
    timer.tick();
    await waitFor(async () => (await shardLines()) === 5, "live sweep commits epoch 1");
    expect(handle.currentEpoch()).toBe(2);

    await handle.shutdown();
    daemon = null;

    const store = await FileSoulStore.open(chainDir, { doorPublicKeys: doorKeys });
    const shards: string[] = [];
    let journals = 0;
    for await (const record of store.iterate()) {
      if (record.type === "memory" && record.body.kind === "shard") {
        shards.push(String(record.residency));
        if ("journal_cid" in record.body) journals += 1;
      }
    }
    expect(shards).toEqual(Array.from({ length: 5 }, () => `door:${doorId}/epoch:1`));
    expect(journals).toBe(1);
    expect((await verifyChain(store, { doorPublicKeys: doorKeys })).valid).toBe(true);
    await store.close();
  });
});
