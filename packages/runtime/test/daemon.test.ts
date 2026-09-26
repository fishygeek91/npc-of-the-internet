import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Door,
  HttpDoorServer,
  OutboundFrameSchema,
  type HostPolicy,
  type OutboundFrame,
  WsDoorSessionServer
} from "@npc/door-sdk";
import {
  OSP_SPEC_V02,
  createRecord,
  encodeBase64Url,
  encodePublicKey,
  FileSoulStore
} from "@npc/osp-core";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { FakeBrain } from "../src/brain/fake-brain.js";
import type { DaemonConfig } from "../src/daemon-config.js";
import { loadReplicationConfig } from "../src/replication/config.js";
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
  capabilities: ["session.text", "session.reactions", "heartbeat", "attest", "cosign.manual"]
};

type DaemonTestEnv = {
  chainDir: string;
  soulKeyPath: string;
  readyFilePath: string;
  httpServer: HttpDoorServer;
  wsServer: WsDoorSessionServer;
  httpHost: string;
  httpPort: number;
  door: Door;
  config: DaemonConfig;
};

async function createDaemonTestEnv(): Promise<DaemonTestEnv> {
  const chainDir = await mkdtemp(join(tmpdir(), "npc-daemon-chain-"));
  const soulKeyPath = join(chainDir, "soul.key");
  const readyFilePath = join(chainDir, "ready");

  await writeFile(soulKeyPath, encodeBase64Url(SOUL.privateKey), "utf8");

  const store = await FileSoulStore.open(chainDir, {
    doorPublicKeys: { [DOOR_ID]: DOOR.publicKey }
  });
  const genesis = await createRecord({
    spec: OSP_SPEC_V02,
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
    // Real clock so Session-issued timestamps stay within Door issued_at skew.
    clock: { now: () => new Date().toISOString() },
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
    doorPublicKeys: { [DOOR_ID]: DOOR.publicKey },
    brain: {
      apiKey: "test-api-key",
      model: "claude-sonnet-4-20250514",
      maxTokens: 1024,
      timeoutMs: 60_000
    },
    readyFilePath,
    replication: loadReplicationConfig({}),
    // Legacy door/0.1 behaviour for the existing echo tests; selective mode has its own test.
    attentionMode: "always"
  };

  return {
    chainDir,
    soulKeyPath,
    readyFilePath,
    httpServer,
    wsServer,
    httpHost,
    httpPort,
    door,
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
      doorPublicKeys: { [DOOR_ID]: DOOR.publicKey }
    });
    await reopened.close();
  });

  it("serializes concurrent inbound frames through one Brain at a time", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let callIndex = 0;
    const brain = new FakeBrain(async (messages) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      callIndex += 1;
      if (callIndex === 1) {
        await firstGate;
      }
      inFlight -= 1;
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      return `echo:${lastUser?.content ?? ""}`;
    });

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

    const outbounds: Array<Record<string, unknown>> = [];
    const outboundDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("outbound timeout")), 5000);
      serverSocket.on("message", (data: WebSocket.RawData) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        outbounds.push(JSON.parse(text) as Record<string, unknown>);
        if (outbounds.length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    env.wsServer.broadcastInbound({ text: "msg-a", author_id: "user-daemon" }, "in-daemon-a");
    env.wsServer.broadcastInbound({ text: "msg-b", author_id: "user-daemon" }, "in-daemon-b");

    const started = Date.now();
    while (brain.calls.length < 1) {
      if (Date.now() - started > 2000) {
        throw new Error("first Brain call did not start");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    // Still gated on first complete — second must not start yet.
    expect(brain.calls).toHaveLength(1);

    if (releaseFirst === undefined) {
      throw new Error("expected first Brain gate");
    }
    releaseFirst();
    await outboundDone;

    expect(maxInFlight).toBe(1);
    expect(brain.calls).toHaveLength(2);
    expect(outbounds).toHaveLength(2);
    expect(outbounds[0]?.body).toEqual({ text: "echo:msg-a" });
    expect(outbounds[1]?.body).toEqual({ text: "echo:msg-b" });

    const secondCallUsers = brain.calls[1]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(secondCallUsers).toEqual(["msg-a", "msg-b"]);

    await handle.shutdown();
  });
  it("selective attention: silence, a reaction-only frame, then threaded speech — all Door-verified", async () => {
    const brain = new FakeBrain([
      '{"say": null, "reply_to": null, "react": null}',
      '{"say": null, "reply_to": null, "react": {"emoji": "🔥", "to": "#2"}}',
      '{"say": "I heard my name.", "reply_to": "#3", "react": null}'
    ]);
    const handle = await startResidencyDaemon(
      { ...env.config, attentionMode: "selective" },
      { brain, logger: pino({ level: "silent" }), skipSignals: true }
    );
    await waitForReadyFile(env.readyFilePath);

    const serverSocket = [...env.wsServer.getActiveClients()][0];
    if (serverSocket === undefined) {
      throw new Error("expected one active server socket");
    }
    const outbounds: OutboundFrame[] = [];
    serverSocket.on("message", (data: WebSocket.RawData) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      outbounds.push(OutboundFrameSchema.parse(JSON.parse(text)));
    });

    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > 5000) {
          throw new Error("timed out waiting for daemon");
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    };

    env.wsServer.broadcastInbound({ text: "just us talking", author_id: "u1" }, "in-sel-1");
    await waitFor(() => brain.calls.length === 1);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(outbounds).toHaveLength(0);

    env.wsServer.broadcastInbound({ text: "that was great", author_id: "u2" }, "in-sel-2");
    await waitFor(() => outbounds.length === 1);

    env.wsServer.broadcastInbound(
      { text: "what do you think?", author_id: "u1", addressed: true },
      "in-sel-3"
    );
    await waitFor(() => outbounds.length === 2);

    expect(outbounds[0]?.body).toEqual({
      reaction: { emoji: "🔥", target_msg_id: "in-sel-2" }
    });
    expect(outbounds[1]?.body).toEqual({ text: "I heard my name.", reply_to: "in-sel-3" });
    for (const frame of outbounds) {
      expect(env.door.verifyOutbound(frame)).toBe(true);
    }

    await handle.shutdown();
  });
});
