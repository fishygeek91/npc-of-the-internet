import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { DoorError } from "../src/errors.js";
import { DOOR_PROTOCOL_VERSION, type HelloResponse } from "../src/schemas.js";
import { helloResponseSigningPayload, sessionBindSigningPayload } from "../src/signing.js";
import { HttpDoorConnection } from "../src/transports/http-client.js";
import { MAX_HTTP_BODY_BYTES } from "../src/transports/http.js";
import { WsDoorSessionClient } from "../src/transports/ws-client.js";
import { WS_MAX_PAYLOAD_BYTES } from "../src/transports/ws.js";

const DOOR_ID = "web:cap";
const ISSUED_AT = "2026-11-16T00:00:00.000Z";

/**
 * Loopback server. `onRequest` must not throw; the caller closes the socket
 * when the client aborts an oversized read.
 */
async function withHttpServer(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    req.resume();
    onRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("expected TCP listen address");
  }
  try {
    await run(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** Stream `total` bytes with no Content-Length (chunked). Bytes are not JSON. */
function writeChunked(res: ServerResponse, total: number): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  const chunk = Buffer.alloc(Math.min(64 * 1024, total), 0x78);
  let sent = 0;
  const writeMore = (): void => {
    try {
      while (sent < total) {
        const size = Math.min(chunk.length, total - sent);
        const ok = res.write(chunk.subarray(0, size));
        sent += size;
        if (!ok) {
          res.once("drain", writeMore);
          return;
        }
      }
      res.end();
    } catch {
      res.destroy();
    }
  };
  writeMore();
}

function signedHelloBody(pad: string, door: Ed25519Keypair, doorPubkey: string): Buffer {
  const unsigned: Omit<HelloResponse, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: DOOR_ID,
    door_pubkey: doorPubkey,
    active_epoch: null,
    capabilities: ["session.text", pad],
    community: {
      name: "Cap",
      description: "Size cap test.",
      platform: "web",
      invitation_required: false
    },
    issued_at: ISSUED_AT
  };
  const sig = encodeSignature(sign(helloResponseSigningPayload(unsigned), door.privateKey));
  return Buffer.from(JSON.stringify({ ...unsigned, sig }), "utf8");
}

/** Signed hello whose UTF-8 JSON is exactly {@link MAX_HTTP_BODY_BYTES}. */
function helloAtCap(door: Ed25519Keypair, doorPubkey: string): Buffer {
  let pad = "x";
  let body = signedHelloBody(pad, door, doorPubkey);
  for (let attempt = 0; attempt < 3 && body.byteLength !== MAX_HTTP_BODY_BYTES; attempt += 1) {
    const next = pad.length + (MAX_HTTP_BODY_BYTES - body.byteLength);
    if (next < 1) {
      throw new Error("hello skeleton exceeds MAX_HTTP_BODY_BYTES");
    }
    pad = "x".padEnd(next, "a");
    body = signedHelloBody(pad, door, doorPubkey);
  }
  if (body.byteLength !== MAX_HTTP_BODY_BYTES) {
    throw new Error(`hello fixture is ${String(body.byteLength)} bytes`);
  }
  return body;
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

describe("HttpDoorConnection response cap", () => {
  const soulPubkey = encodePublicKey(generateKeypair().publicKey);
  const hello = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    soul_pubkey: soulPubkey
  };

  it("rejects a chunked body over MAX_HTTP_BODY_BYTES before JSON.parse", async () => {
    await withHttpServer(
      (_req, res) => {
        writeChunked(res, MAX_HTTP_BODY_BYTES + 1);
      },
      async (baseUrl) => {
        const client = new HttpDoorConnection({ baseUrl });
        const error = await client.hello(hello).then(
          () => {
            throw new Error("expected payload_too_large");
          },
          (caught: unknown) => caught
        );
        expect(error).toBeInstanceOf(DoorError);
        if (!(error instanceof DoorError)) {
          throw new Error("expected DoorError");
        }
        expect(error.code).toBe("payload_too_large");
        expect(error.httpStatus).toBe(413);
        expect(error.cause).toBeUndefined();
        expect(error.message).not.toContain("x".repeat(8));
      }
    );
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    let markClosed = (): void => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    await withHttpServer(
      (req, res) => {
        req.on("close", () => markClosed());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_HTTP_BODY_BYTES + 1)
        });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const client = new HttpDoorConnection({ baseUrl });
        await expect(client.hello(hello)).rejects.toMatchObject({
          code: "payload_too_large",
          httpStatus: 413
        });
        await closed;
      }
    );
  });

  it("accepts a signed hello whose body is exactly MAX_HTTP_BODY_BYTES", async () => {
    const door = generateKeypair();
    const doorPubkey = encodePublicKey(door.publicKey);
    const body = helloAtCap(door, doorPubkey);
    await withHttpServer(
      (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(body.byteLength)
        });
        res.end(body);
      },
      async (baseUrl) => {
        const client = new HttpDoorConnection({ baseUrl });
        const response = await client.hello(hello);
        expect(response.door_id).toBe(DOOR_ID);
        expect(response.door_pubkey).toBe(doorPubkey);
        const pad = response.capabilities[1];
        expect(typeof pad).toBe("string");
        if (typeof pad !== "string") {
          throw new Error("expected padded capability");
        }
        expect(pad.charCodeAt(0)).toBe(120);
        expect(pad.length).toBeGreaterThan(1000);
      }
    );
  });
});

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

  async function startPeer(): Promise<{
    port: number;
    httpServer: Server;
    wss: WebSocketServer;
  }> {
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
    return { port: address.port, httpServer, wss };
  }

  async function stopPeer(httpServer: Server, wss: WebSocketServer): Promise<void> {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await closeServer(httpServer);
  }

  it("closes when a frame exceeds WS_MAX_PAYLOAD_BYTES", async () => {
    const peer = await startPeer();
    let releaseSleep = (): void => {};
    const slept = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let markDisconnected = (): void => {};
    const disconnected = new Promise<void>((resolve) => {
      markDisconnected = resolve;
    });
    let inbound = 0;
    const client = new WsDoorSessionClient({
      wsBaseUrl: `ws://127.0.0.1:${String(peer.port)}`,
      bind: bindProof(),
      sleep: () => slept,
      onInbound: () => {
        inbound += 1;
      },
      onConnectionChange: (connected) => {
        if (!connected) {
          markDisconnected();
        }
      }
    });
    const opened = new Promise<WebSocket>((resolve) => {
      peer.wss.once("connection", (socket) => {
        socket.on("error", () => {});
        resolve(socket);
      });
    });
    try {
      const connectPromise = client.connect();
      const serverSocket = await opened;
      await connectPromise;
      const closed = new Promise<number>((resolve) => {
        serverSocket.once("close", (code) => resolve(code));
      });
      serverSocket.send(Buffer.alloc(WS_MAX_PAYLOAD_BYTES + 1, 0x61));
      const code = await closed;
      await disconnected;
      expect(code).toBe(1009);
      expect(client.isConnected()).toBe(false);
      expect(inbound).toBe(0);
    } finally {
      await client.close();
      releaseSleep();
      await stopPeer(peer.httpServer, peer.wss);
    }
  });

  it("accepts a control frame of exactly WS_MAX_PAYLOAD_BYTES and answers ping", async () => {
    const peer = await startPeer();
    let releaseSleep = (): void => {};
    const slept = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const client = new WsDoorSessionClient({
      wsBaseUrl: `ws://127.0.0.1:${String(peer.port)}`,
      bind: bindProof(),
      sleep: () => slept,
      clock: { now: () => ISSUED_AT }
    });
    const opened = new Promise<WebSocket>((resolve) => {
      peer.wss.once("connection", (socket) => {
        socket.on("error", () => {});
        resolve(socket);
      });
    });
    try {
      const connectPromise = client.connect();
      const serverSocket = await opened;
      await connectPromise;
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
        serverSocket.once("message", (data) => resolve(dataToText(data)));
      });
      serverSocket.send(frame);
      const text = await pong;
      const parsed: unknown = JSON.parse(text);
      expect(parsed).toMatchObject({
        type: "control",
        door_id: DOOR_ID,
        body: { action: "pong" }
      });
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
      releaseSleep();
      await stopPeer(peer.httpServer, peer.wss);
    }
  });
});
