import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Door, HttpDoorServer, type HostPolicy, WsDoorSessionServer } from "@npc/door-sdk";
import { createRecord, encodeBase64Url, encodePublicKey, FileSoulStore } from "@npc/osp-core";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { FakeBrain } from "../src/brain/fake-brain.js";
import type { DaemonConfig } from "../src/daemon-config.js";
import { startResidencyDaemon } from "../src/daemon.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";

const DOOR_ID = "discord:daemon-test";
const REPLY_TEXT = "I hear you through the WebSocket bind.";

const defaultPolicy: HostPolicy = {
  community: {
    name: "Daemon Test Guild",
    description: "Residency daemon integration tests.",
    platform: "discord",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
};

type DaemonTestEnv = {
  chainDir: string;
  soulKeyPath: string;
  readyFilePath: string;
  httpServer: HttpDoorServer;
  wsServer: WsDoorSessionServer;
  httpHost: string;
  httpPort: number;
  config: DaemonConfig;
};

async function createDaemonTestEnv(): Promise<DaemonTestEnv> {
  const chainDir = await mkdtemp(join(tmpdir(), "npc-daemon-chain-"));
  const soulKeyPath = join(chainDir, "soul.key");
  const readyFilePath = join(chainDir, "ready");

  await writeFile(soulKeyPath, encodeBase64Url(SOUL.privateKey), "utf8");

  const store = await FileSoulStore.open(chainDir, {
    doorPublicKeys: [DOOR.publicKey]
  });
  const genesis = await createRecord({
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nDaemon integration test.",
      soul_pubkey: encodePublicKey(SOUL.publicKey),
      created_at: "2026-07-20T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: SOUL.privateKey
  });
  await store.append(genesis.record);
  await store.close();

  const door = new Door({
    doorId: DOOR_ID,
    doorKeypair: DOOR,
    soulPublicKey: SOUL.publicKey,
    clock: { now: () => "2026-07-20T15:04:05.123Z" },
    policy: defaultPolicy
  });

  const httpServer = new HttpDoorServer({ door });
  const httpInfo = await httpServer.start();
  const wsServer = new WsDoorSessionServer({ door, server: httpServer.nodeServer });
  await wsServer.start();

  const url = new URL(httpInfo.baseUrl);
  const httpHost = url.hostname;
  const httpPort = Number.parseInt(url.port, 10);

  const config: DaemonConfig = {
    soulKeyPath,
    soulchainDir: chainDir,
    doorHttpHost: httpHost,
    doorHttpPort: httpPort,
    doorId: DOOR_ID,
    doorPublicKeys: [DOOR.publicKey],
    brain: {
      apiKey: "test-api-key",
      model: "claude-sonnet-4-20250514",
      maxTokens: 1024,
      timeoutMs: 60_000
    },
    readyFilePath
  };

  return {
    chainDir,
    soulKeyPath,
    readyFilePath,
    httpServer,
    wsServer,
    httpHost,
    httpPort,
    config
  };
}

function waitForReadyFile(path: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      void readFile(path, "utf8")
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`ready file not written within ${String(timeoutMs)}ms`));
            return;
          }
          setTimeout(check, 50);
        });
    };
    check();
  });
}

describe("startResidencyDaemon", () => {
  let env: DaemonTestEnv;

  beforeEach(async () => {
    env = await createDaemonTestEnv();
  });

  afterEach(async () => {
    await env.wsServer.stop();
    await env.httpServer.stop();
  });

  it("arrives, binds WS, handles inbound traffic, and shuts down cleanly", async () => {
    const brain = new FakeBrain([REPLY_TEXT]);
    const handle = await startResidencyDaemon(env.config, {
      brain,
      logger: pino({ level: "silent" }),
      skipSignals: true
    });

    await waitForReadyFile(env.readyFilePath);

    const serverSockets = [...env.wsServer.getActiveClients()];
    expect(serverSockets.length).toBe(1);
    const serverSocket = serverSockets[0];
    if (serverSocket === undefined) {
      throw new Error("expected one active server socket");
    }

    const outboundPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("outbound timeout")), 5000);
      serverSocket.once("message", (data: WebSocket.RawData) => {
        clearTimeout(timer);
        const text = typeof data === "string" ? data : data.toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
    });

    env.wsServer.broadcastInbound(
      { text: "Hello from the guild.", author_id: "user-daemon" },
      "in-daemon-1"
    );

    const outbound = await outboundPromise;
    expect(outbound.type).toBe("outbound");
    expect(outbound.body).toEqual({ text: REPLY_TEXT });

    await handle.shutdown();

    await expect(readFile(env.readyFilePath, "utf8")).rejects.toThrow();

    const reopened = await FileSoulStore.open(env.chainDir, {
      doorPublicKeys: [DOOR.publicKey]
    });
    await reopened.close();
  });
});
