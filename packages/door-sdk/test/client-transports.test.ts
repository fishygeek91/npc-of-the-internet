import { createServer } from "node:http";

import {
  canonicalize,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { Door } from "../src/door.js";
import { DoorError } from "../src/errors.js";
import type { HostPolicy } from "../src/policy.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";
import type {
  AttestRequest,
  CosignCandidateShard,
  CosignRequest,
  HeartbeatRequest,
  OutboundFrame
} from "../src/schemas.js";
import {
  attestSigningPayload,
  cosignReviewSigningPayload,
  outboundSigningPayload,
  sessionBindSigningPayload
} from "../src/signing.js";
import { HttpDoorConnection } from "../src/transports/http-client.js";
import { HttpDoorServer } from "../src/transports/http.js";
import { InProcessDoorConnection } from "../src/transports/in-process.js";
import { WsDoorSessionServer } from "../src/transports/ws.js";
import { WsDoorSessionClient, type WebSocketLike } from "../src/transports/ws-client.js";

const DOOR_ID = "discord:client";
const EPOCH = 50;
const ISSUED_AT = "2026-07-20T15:04:05.123Z";
const RECEIVED_AT = "2026-07-20T15:10:00.000Z";
const CORE = '{"type":"attestation","kind":"arrival"}';

class FakeClock {
  constructor(private readonly fixed: string) {}

  now(): string {
    return this.fixed;
  }
}

const defaultPolicy: HostPolicy = {
  community: {
    name: "Client Transport Guild",
    description: "Network client transport tests.",
    platform: "discord",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
};

function signAttestRequest(
  soul: Ed25519Keypair,
  session: Ed25519Keypair,
  fields: Omit<AttestRequest, "sig">,
  useSoulKey: boolean
): AttestRequest {
  const payload = attestSigningPayload(fields);
  const signature = useSoulKey ? sign(payload, soul.privateKey) : sign(payload, session.privateKey);
  return { ...fields, sig: encodeSignature(signature) };
}

function signHeartbeatRequest(
  session: Ed25519Keypair,
  fields: Omit<HeartbeatRequest, "sig">
): HeartbeatRequest {
  const payload = canonicalize(fields);
  return { ...fields, sig: encodeSignature(sign(payload, session.privateKey)) };
}

function signOutboundFrame(
  session: Ed25519Keypair,
  frame: Omit<OutboundFrame, "sig">
): OutboundFrame {
  const payload = outboundSigningPayload(frame);
  return { ...frame, sig: encodeSignature(sign(payload, session.privateKey)) };
}

function sampleShards(count: number): CosignCandidateShard[] {
  return Array.from({ length: count }, (_, index) => ({
    shard_id: `shard_${String(index + 1).padStart(2, "0")}`,
    text: `Memory shard ${String(index + 1)} from the residency.`
  }));
}

function signCosignReviewRequest(
  session: Ed25519Keypair,
  fields: Omit<Extract<CosignRequest, { phase: "review" }>, "sig">
): Extract<CosignRequest, { phase: "review" }> {
  const payload = cosignReviewSigningPayload(fields);
  return { ...fields, sig: encodeSignature(sign(payload, session.privateKey)) };
}

function sessionBindParams(
  session: Ed25519Keypair,
  doorId: string,
  epoch: number
): { door_id: string; epoch: number; session_pubkey: string; session_sig: string } {
  const sessionPubkey = encodePublicKey(session.publicKey);
  const payload = sessionBindSigningPayload({
    door_id: doorId,
    epoch,
    session_pubkey: sessionPubkey
  });
  return {
    door_id: doorId,
    epoch,
    session_pubkey: sessionPubkey,
    session_sig: encodeSignature(sign(payload, session.privateKey))
  };
}

type ClientTestEnv = {
  soul: Ed25519Keypair;
  session: Ed25519Keypair;
  inProcessDoor: Door;
  httpDoor: Door;
  inProcess: InProcessDoorConnection;
  httpClient: HttpDoorConnection;
  httpServer: HttpDoorServer;
  httpBaseUrl: string;
  wsServer: WsDoorSessionServer;
  wsBaseUrl: string;
};

async function createClientTestEnv(): Promise<ClientTestEnv> {
  const soul = generateKeypair();
  const session = generateKeypair();
  const clock = new FakeClock(RECEIVED_AT);
  const doorOptions = {
    doorId: DOOR_ID,
    doorKeypair: generateKeypair(),
    soulPublicKey: soul.publicKey,
    clock,
    policy: defaultPolicy
  };

  const inProcessDoor = new Door(doorOptions);
  const httpDoor = new Door(doorOptions);
  const inProcess = new InProcessDoorConnection(inProcessDoor);
  const httpServer = new HttpDoorServer({ door: httpDoor });
  const httpInfo = await httpServer.start();
  const httpClient = new HttpDoorConnection({ baseUrl: httpInfo.baseUrl });
  const wsServer = new WsDoorSessionServer({ door: inProcessDoor, server: httpServer.nodeServer });
  const wsInfo = await wsServer.start();

  return {
    soul,
    session,
    inProcessDoor,
    httpDoor,
    inProcess,
    httpClient,
    httpServer,
    httpBaseUrl: httpInfo.baseUrl,
    wsServer,
    wsBaseUrl: `ws://${wsInfo.host}:${String(wsInfo.port)}`
  };
}

describe("HttpDoorConnection", () => {
  let env: ClientTestEnv;

  beforeEach(async () => {
    env = await createClientTestEnv();
  });

  afterEach(async () => {
    await env.wsServer.stop();
    await env.httpServer.stop();
  });

  it("hello matches InProcessDoorConnection", async () => {
    const request = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(env.soul.publicKey)
    };
    const inProcessResponse = await env.inProcess.hello(request);
    const httpResponse = await env.httpClient.hello(request);
    expect(httpResponse).toEqual(inProcessResponse);
  });

  it("attest matches InProcessDoorConnection", async () => {
    const request = signAttestRequest(
      env.soul,
      env.session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(env.session.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );

    const inProcessResponse = await env.inProcess.attest(request);
    const httpResponse = await env.httpClient.attest(request);
    expect(httpResponse.door_cosig).toBe(inProcessResponse.door_cosig);
    expect(httpResponse.door_sig).toBe(inProcessResponse.door_sig);
  });

  it("heartbeat matches InProcessDoorConnection", async () => {
    const epoch = EPOCH + 1;
    const arrival = signAttestRequest(
      env.soul,
      env.session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(env.session.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await env.inProcess.attest(arrival);
    await env.httpClient.attest(arrival);

    const heartbeat = signHeartbeatRequest(env.session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch,
      session_pubkey: encodePublicKey(env.session.publicKey),
      seq: 1,
      issued_at: ISSUED_AT
    });

    const inProcessResponse = await env.inProcess.heartbeat(heartbeat);
    const httpResponse = await env.httpClient.heartbeat(heartbeat);
    expect(httpResponse).toEqual(inProcessResponse);
  });

  it("cosign review matches InProcessDoorConnection", async () => {
    const epoch = EPOCH + 2;
    const arrival = signAttestRequest(
      env.soul,
      env.session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(env.session.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await env.inProcess.attest(arrival);
    await env.httpClient.attest(arrival);

    const reviewRequest = signCosignReviewRequest(env.session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: DOOR_ID,
      epoch,
      session_pubkey: encodePublicKey(env.session.publicKey),
      shards: sampleShards(5),
      issued_at: ISSUED_AT
    });

    const inProcessResponse = await env.inProcess.cosign(reviewRequest);
    const httpResponse = await env.httpClient.cosign(reviewRequest);
    expect(httpResponse).toEqual(inProcessResponse);
  });

  it("throws DoorError on server DoorError responses", async () => {
    const arrival = signAttestRequest(
      env.soul,
      env.session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH + 3,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(env.session.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await env.httpClient.attest(arrival);

    const mismatch = signAttestRequest(
      env.soul,
      env.session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH + 4,
        kind: "departure",
        core: '{"type":"attestation","kind":"departure"}',
        session_pubkey: encodePublicKey(env.session.publicKey),
        issued_at: ISSUED_AT
      },
      false
    );

    await expect(env.httpClient.attest(mismatch)).rejects.toBeInstanceOf(DoorError);
    await expect(env.httpClient.attest(mismatch)).rejects.toMatchObject({
      code: "epoch_mismatch",
      httpStatus: 409
    });
  });

  it("preserves a non-Door error body snippet in details", async () => {
    const proxyBody = { message: "bad gateway from upstream proxy" };
    const server = createServer((_req, res) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify(proxyBody));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP listen address");
    }

    try {
      const client = new HttpDoorConnection({
        baseUrl: `http://127.0.0.1:${String(address.port)}`
      });
      await expect(
        client.hello({
          protocol_version: DOOR_PROTOCOL_VERSION,
          soul_pubkey: encodePublicKey(env.soul.publicKey)
        })
      ).rejects.toMatchObject({
        code: "door_unavailable",
        httpStatus: 502,
        details: { body: JSON.stringify(proxyBody) }
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});

describe("WsDoorSessionClient", () => {
  let env: ClientTestEnv;

  beforeEach(async () => {
    env = await createClientTestEnv();
  });

  afterEach(async () => {
    await env.wsServer.stop();
    await env.httpServer.stop();
  });

  async function establishArrival(epoch: number): Promise<void> {
    const arrival = signAttestRequest(
      env.soul,
      env.session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(env.session.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await env.inProcessDoor.attest(arrival);
  }

  it("binds, responds to ping with pong, and sends signed outbound", async () => {
    const epoch = EPOCH + 10;
    await establishArrival(epoch);
    const bind = sessionBindParams(env.session, DOOR_ID, epoch);
    const clock = new FakeClock(ISSUED_AT);

    const client = new WsDoorSessionClient({
      wsBaseUrl: env.wsBaseUrl,
      bind,
      clock
    });
    await client.connect();
    expect(client.isConnected()).toBe(true);

    const serverSockets = [...env.wsServer.getActiveClients()];
    expect(serverSockets.length).toBe(1);
    const serverSocket = serverSockets[0];
    if (serverSocket === undefined) {
      throw new Error("expected one active server socket");
    }

    const pingFrame = {
      type: "control",
      door_id: DOOR_ID,
      epoch,
      msg_id: "ctrl_ping_client",
      issued_at: ISSUED_AT,
      body: { action: "ping" }
    };

    const pongPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pong timeout")), 3000);
      serverSocket.once("message", (data) => {
        clearTimeout(timer);
        const text = typeof data === "string" ? data : data.toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
    });

    serverSocket.send(JSON.stringify(pingFrame));
    const pong = await pongPromise;
    expect(pong.body).toEqual({ action: "pong" });

    const outbound = signOutboundFrame(env.session, {
      type: "outbound",
      door_id: DOOR_ID,
      epoch,
      msg_id: "msg_client_out",
      issued_at: ISSUED_AT,
      body: { text: "Hello from WsDoorSessionClient." }
    });

    const stayOpen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 300);
      serverSocket.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`socket closed unexpectedly with code ${String(code)}`));
      });
    });

    client.sendOutbound(outbound);
    await stayOpen;
    await client.close();
  });

  it("rejects bad bind with close code 4401 and does not reconnect", async () => {
    const epoch = EPOCH + 11;
    await establishArrival(epoch);

    let connectAttempts = 0;
    const client = new WsDoorSessionClient({
      wsBaseUrl: env.wsBaseUrl,
      bind: sessionBindParams(generateKeypair(), DOOR_ID, epoch),
      initialBackoffMs: 20,
      maxBackoffMs: 40,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      createWebSocket: (url) => {
        connectAttempts += 1;
        return new WebSocket(url);
      }
    });

    await expect(client.connect()).rejects.toMatchObject({ code: "session_invalid" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connectAttempts).toBe(1);
    await client.close();
  });

  it("close during in-flight connect does not leave a live socket", async () => {
    const epoch = EPOCH + 13;
    await establishArrival(epoch);
    const bind = sessionBindParams(env.session, DOOR_ID, epoch);

    type Listener = (...args: never[]) => void;
    let readyState = WebSocket.CONNECTING;
    const onceListeners = new Map<string, Listener[]>();
    let closeCalls = 0;

    const deferredSocket: WebSocketLike = {
      get readyState() {
        return readyState;
      },
      send() {
        // unused
      },
      close() {
        closeCalls += 1;
        readyState = WebSocket.CLOSED;
        const listeners = onceListeners.get("close") ?? [];
        onceListeners.delete("close");
        for (const listener of listeners) {
          listener(1000, Buffer.alloc(0));
        }
      },
      on() {
        // unused for this race
      },
      once(event, listener) {
        const list = onceListeners.get(event) ?? [];
        list.push(listener as Listener);
        onceListeners.set(event, list);
      },
      removeAllListeners(event) {
        if (event === undefined) {
          onceListeners.clear();
          return;
        }
        onceListeners.delete(event);
      }
    };

    const client = new WsDoorSessionClient({
      wsBaseUrl: env.wsBaseUrl,
      bind,
      createWebSocket: () => deferredSocket
    });

    const connectPromise = client.connect();
    await client.close();

    readyState = WebSocket.OPEN;
    const openListeners = onceListeners.get("open") ?? [];
    for (const listener of openListeners) {
      listener();
    }

    await expect(connectPromise).rejects.toThrow(/closed/);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.isConnected()).toBe(false);
    expect(closeCalls).toBeGreaterThanOrEqual(1);
    expect(env.wsServer.getActiveClients().size).toBe(0);
  });

  it("reconnects after the server drops the connection", async () => {
    const epoch = EPOCH + 12;
    await establishArrival(epoch);
    const bind = sessionBindParams(env.session, DOOR_ID, epoch);

    const connectionChanges: boolean[] = [];
    let clientSocket: WebSocket | undefined;
    let socketCount = 0;

    const client = new WsDoorSessionClient({
      wsBaseUrl: env.wsBaseUrl,
      bind,
      initialBackoffMs: 30,
      maxBackoffMs: 60,
      sleep: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      onConnectionChange: (connected) => {
        connectionChanges.push(connected);
      },
      createWebSocket: (url): WebSocketLike => {
        socketCount += 1;
        const socket = new WebSocket(url);
        clientSocket = socket;
        return socket;
      }
    });

    try {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(socketCount).toBe(1);

      if (clientSocket === undefined) {
        throw new Error("expected client WebSocket instance");
      }
      clientSocket.terminate();

      await vi.waitFor(
        () => {
          expect(socketCount).toBeGreaterThanOrEqual(2);
          expect(client.isConnected()).toBe(true);
        },
        { timeout: 2000 }
      );

      expect(connectionChanges).toContain(false);
      expect(connectionChanges.at(-1)).toBe(true);
    } finally {
      await client.close();
    }
  });
});
