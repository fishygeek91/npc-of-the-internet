import { createServer, type Server } from "node:http";

import { encodePublicKey, encodeSignature, generateKeypair, sign } from "@npc/osp-core";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { sessionBindSigningPayload } from "../src/signing.js";
import { WsDoorSessionClient } from "../src/transports/ws-client.js";
import { WS_MAX_PAYLOAD_BYTES } from "../src/transports/ws.js";

const DOOR_ID = "web:cap";
const ISSUED_AT = "2026-11-16T00:00:00.000Z";

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function dataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

describe("WsDoorSessionClient payload cap", () => {
  function bindProof(): {
    door_id: string;
    epoch: number;
    session_pubkey: string;
    session_sig: string;
  } {
    const session = generateKeypair();
    const sessionPubkey = encodePublicKey(session.publicKey);
    const fields = { door_id: DOOR_ID, epoch: 1, session_pubkey: sessionPubkey };
    return {
      ...fields,
      session_sig: encodeSignature(sign(sessionBindSigningPayload(fields), session.privateKey))
    };
  }

  async function withClient(
    extra: {
      clock?: { now: () => string };
      onInbound?: () => void;
      onConnectionChange?: (connected: boolean) => void;
    },
    run: (socket: WebSocket, client: WsDoorSessionClient) => Promise<void>
  ): Promise<void> {
    const httpServer = createServer();
    httpServer.on("error", () => {});
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP listen address");
    }
    let releaseSleep = (): void => {};
    const slept = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const client = new WsDoorSessionClient({
      wsBaseUrl: `ws://127.0.0.1:${String(address.port)}`,
      bind: bindProof(),
      sleep: () => slept,
      ...extra
    });
    const opened = new Promise<WebSocket>((resolve) => {
      wss.once("connection", (socket) => {
        socket.on("error", () => {});
        resolve(socket);
      });
    });
    try {
      const connecting = client.connect();
      const socket = await opened;
      await connecting;
      await run(socket, client);
    } finally {
      await client.close();
      releaseSleep();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await closeServer(httpServer);
    }
  }

  it("closes when a frame exceeds WS_MAX_PAYLOAD_BYTES", async () => {
    let inbound = 0;
    let markDisconnected = (): void => {};
    const disconnected = new Promise<void>((resolve) => {
      markDisconnected = resolve;
    });
    await withClient(
      {
        onInbound: () => {
          inbound += 1;
        },
        onConnectionChange: (connected) => {
          if (!connected) {
            markDisconnected();
          }
        }
      },
      async (socket, client) => {
        const closed = new Promise<number>((resolve) => {
          socket.once("close", (code) => resolve(code));
        });
        socket.send(Buffer.alloc(WS_MAX_PAYLOAD_BYTES + 1, 0x61));
        expect(await closed).toBe(1009);
        await disconnected;
        expect(client.isConnected()).toBe(false);
        expect(inbound).toBe(0);
      }
    );
  });

  it("accepts a control frame of exactly WS_MAX_PAYLOAD_BYTES and answers ping", async () => {
    await withClient({ clock: { now: () => ISSUED_AT } }, async (socket, client) => {
      const prefix = `{"type":"control","door_id":"${DOOR_ID}","epoch":1,"msg_id":"ping-exact","issued_at":"${ISSUED_AT}","body":{"action":"ping","reason":"`;
      const suffix = '"}}';
      const padLen = WS_MAX_PAYLOAD_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      if (padLen < 1) {
        throw new Error("control skeleton exceeds WS_MAX_PAYLOAD_BYTES");
      }
      const frame = `${prefix}${"a".repeat(padLen)}${suffix}`;
      if (Buffer.byteLength(frame) !== WS_MAX_PAYLOAD_BYTES) {
        throw new Error(`control fixture is ${String(Buffer.byteLength(frame))} bytes`);
      }
      const pong = new Promise<string>((resolve) => {
        socket.once("message", (data) => resolve(dataToText(data)));
      });
      socket.send(frame);
      const parsed: unknown = JSON.parse(await pong);
      expect(parsed).toMatchObject({
        type: "control",
        door_id: DOOR_ID,
        body: { action: "pong" }
      });
      expect(client.isConnected()).toBe(true);
    });
  });
});
