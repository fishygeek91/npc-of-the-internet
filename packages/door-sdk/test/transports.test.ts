import {
  canonicalize,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { Door } from "../src/door.js";
import type { HostPolicy } from "../src/policy.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";
import type { AttestRequest, HeartbeatRequest } from "../src/schemas.js";
import {
  attestSigningPayload,
  generateDoorKeypair,
  sessionBindSigningPayload
} from "../src/signing.js";
import { HttpDoorServer, MAX_HTTP_BODY_BYTES } from "../src/transports/http.js";
import { WsDoorSessionServer } from "../src/transports/ws.js";

const DOOR_ID = "discord:http";
const EPOCH = 11;
const ISSUED_AT = "2026-07-20T15:09:00.000Z";
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
    name: "HTTP Test Guild",
    description: "HTTP transport tests.",
    platform: "discord",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
};

function createDoor(soulPublicKey: Uint8Array): Door {
  return new Door({
    doorId: DOOR_ID,
    doorKeypair: generateDoorKeypair(),
    soulPublicKey,
    clock: new FakeClock(RECEIVED_AT),
    policy: defaultPolicy
  });
}

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

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: json };
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

function wsSessionUrl(
  host: string,
  port: number,
  bind: ReturnType<typeof sessionBindParams>
): string {
  const params = new URLSearchParams({
    door_id: bind.door_id,
    epoch: String(bind.epoch),
    session_pubkey: bind.session_pubkey,
    session_sig: bind.session_sig
  });
  return `ws://${host}:${String(port)}/door/session?${params.toString()}`;
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 3000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForWebSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  if (socket.readyState === WebSocket.CLOSED) {
    return { code: 1000, reason: "" };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timeout")), 3000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function postRaw(
  baseUrl: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: string | Buffer;
    streamChunks?: Buffer[];
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`${baseUrl}${path}`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...options.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: Record<string, unknown> = {};
          if (text.length > 0) {
            body = JSON.parse(text) as Record<string, unknown>;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    if (options.streamChunks !== undefined) {
      for (const chunk of options.streamChunks) {
        req.write(chunk);
      }
      req.end();
      return;
    }
    if (options.body !== undefined) {
      req.end(options.body);
      return;
    }
    req.end();
  });
}

describe("HTTP transport", () => {
  let httpServer: HttpDoorServer | null = null;

  afterEach(async () => {
    if (httpServer !== null) {
      await httpServer.stop();
      httpServer = null;
    }
  });

  it("hello returns 200 with signed response", async () => {
    const soul = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const { baseUrl } = await httpServer.start();

    const response = await postJson(baseUrl, "/door/hello", {
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(soul.publicKey)
    });

    expect(response.status).toBe(200);
    expect(response.body.door_id).toBe(DOOR_ID);
    expect(response.body.sig).toBeTypeOf("string");
    expect(response.body.capabilities).toEqual(defaultPolicy.capabilities);
  });

  it("hello with unsupported protocol_version returns unsupported_version", async () => {
    const soul = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const { baseUrl } = await httpServer.start();

    const response = await postJson(baseUrl, "/door/hello", {
      protocol_version: "door/0.2",
      soul_pubkey: encodePublicKey(soul.publicKey)
    });

    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe("unsupported_version");
  });

  it("attest epoch_mismatch returns 409", async () => {
    const soul = generateKeypair();
    const session = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const { baseUrl } = await httpServer.start();

    const arrival = await postJson(
      baseUrl,
      "/door/attest",
      signAttestRequest(
        soul,
        session,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH,
          kind: "arrival",
          core: CORE,
          session_pubkey: encodePublicKey(session.publicKey),
          issued_at: ISSUED_AT
        },
        true
      )
    );
    expect(arrival.status).toBe(200);

    const response = await postJson(
      baseUrl,
      "/door/attest",
      signAttestRequest(
        soul,
        session,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH + 1,
          kind: "departure",
          core: '{"type":"attestation","kind":"departure"}',
          session_pubkey: encodePublicKey(session.publicKey),
          issued_at: ISSUED_AT
        },
        false
      )
    );

    expect(response.status).toBe(409);
    expect((response.body.error as { code: string }).code).toBe("epoch_mismatch");
  });

  it("heartbeat with invalid signature returns 401", async () => {
    const soul = generateKeypair();
    const session = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const { baseUrl } = await httpServer.start();

    await postJson(
      baseUrl,
      "/door/attest",
      signAttestRequest(
        soul,
        session,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH,
          kind: "arrival",
          core: CORE,
          session_pubkey: encodePublicKey(session.publicKey),
          issued_at: ISSUED_AT
        },
        true
      )
    );

    const wrongSession = generateKeypair();
    const unsigned: Omit<HeartbeatRequest, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      seq: 1,
      issued_at: ISSUED_AT
    };
    const badSig = encodeSignature(sign(canonicalize(unsigned), wrongSession.privateKey));

    const response = await postJson(baseUrl, "/door/heartbeat", {
      ...unsigned,
      sig: badSig
    });

    expect(response.status).toBe(401);
    expect((response.body.error as { code: string }).code).toBe("signature_invalid");
  });

  it("oversized Content-Length POST returns 413 payload_too_large", async () => {
    const soul = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const { baseUrl } = await httpServer.start();

    const response = await postRaw(baseUrl, "/door/hello", {
      headers: {
        "Content-Length": String(MAX_HTTP_BODY_BYTES + 1)
      },
      body: "{}"
    });

    expect(response.status).toBe(413);
    expect((response.body.error as { code: string }).code).toBe("payload_too_large");
  });

  it("stream body exceeding 128KiB without Content-Length returns 413", async () => {
    const soul = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const { baseUrl } = await httpServer.start();

    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const response = await postRaw(baseUrl, "/door/hello", {
      streamChunks: [chunk, chunk, chunk]
    });

    expect(response.status).toBe(413);
    expect((response.body.error as { code: string }).code).toBe("payload_too_large");
  });

  it("stream body one byte over 128KiB returns 413", async () => {
    const soul = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const { baseUrl } = await httpServer.start();

    const response = await postRaw(baseUrl, "/door/hello", {
      streamChunks: [Buffer.alloc(MAX_HTTP_BODY_BYTES + 1, 0x62)]
    });

    expect(response.status).toBe(413);
    expect((response.body.error as { code: string }).code).toBe("payload_too_large");
  });
});

describe("HTTP + WS coalesced listener", () => {
  let httpServer: HttpDoorServer | null = null;
  let wsServer: WsDoorSessionServer | null = null;

  afterEach(async () => {
    if (wsServer !== null) {
      await wsServer.stop();
      wsServer = null;
    }
    if (httpServer !== null) {
      await httpServer.stop();
      httpServer = null;
    }
  });

  it("nodeServer throws before start", () => {
    const soul = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    expect(() => httpServer.nodeServer).toThrow("HttpDoorServer is not started");
  });

  it("shares the HTTP listen port when WS attaches via nodeServer", async () => {
    const soul = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const httpBound = await httpServer.start();
    wsServer = new WsDoorSessionServer({ door, server: httpServer.nodeServer });
    const wsBound = await wsServer.start();

    expect(wsBound.port).toBe(httpBound.port);
    expect(wsBound.host).toBe(httpBound.host);
    expect(wsBound.url).toBe(`ws://${httpBound.host}:${String(httpBound.port)}/door/session`);

    const response = await postJson(httpBound.baseUrl, "/door/hello", {
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(soul.publicKey)
    });
    expect(response.status).toBe(200);
  });
});

describe("WS session lifecycle (#66)", () => {
  let httpServer: HttpDoorServer | null = null;
  let wsServer: WsDoorSessionServer | null = null;

  afterEach(async () => {
    if (wsServer !== null) {
      await wsServer.stop();
      wsServer = null;
    }
    if (httpServer !== null) {
      await httpServer.stop();
      httpServer = null;
    }
  });

  it("supersede closes epoch-N socket; broadcast only reaches active epoch", async () => {
    const soul = generateKeypair();
    const sessionN = generateKeypair();
    const sessionN1 = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const httpBound = await httpServer.start();
    wsServer = new WsDoorSessionServer({ door, server: httpServer.nodeServer });
    await wsServer.start();

    await door.attest(
      signAttestRequest(
        soul,
        sessionN,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH,
          kind: "arrival",
          core: CORE,
          session_pubkey: encodePublicKey(sessionN.publicKey),
          issued_at: ISSUED_AT
        },
        true
      )
    );

    const bindN = sessionBindParams(sessionN, DOOR_ID, EPOCH);
    const socketN = new WebSocket(wsSessionUrl(httpBound.host, httpBound.port, bindN));
    await waitForWebSocketOpen(socketN);
    expect(wsServer.getActiveClients().size).toBe(1);

    const sessionEndPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("session_end timeout")), 3000);
      socketN.once("message", (data) => {
        clearTimeout(timer);
        const text = typeof data === "string" ? data : data.toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
    });

    const inboundBeforeSupersede: Record<string, unknown>[] = [];
    socketN.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      const frame = JSON.parse(text) as Record<string, unknown>;
      if (frame.type === "inbound") {
        inboundBeforeSupersede.push(frame);
      }
    });

    await door.attest(
      signAttestRequest(
        soul,
        sessionN1,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH + 1,
          kind: "arrival",
          core: CORE,
          session_pubkey: encodePublicKey(sessionN1.publicKey),
          issued_at: ISSUED_AT
        },
        true
      )
    );

    const sessionEnd = await sessionEndPromise;
    expect(sessionEnd.type).toBe("control");
    expect((sessionEnd.body as { action: string }).action).toBe("session_end");

    const closeInfo = await waitForWebSocketClose(socketN);
    expect([1000, 1005]).toContain(closeInfo.code);
    expect(wsServer.getActiveClients().size).toBe(0);

    wsServer.broadcastInbound({ text: "Should not reach epoch N client." }, "msg_supersede_test");
    expect(inboundBeforeSupersede).toHaveLength(0);

    const bindN1 = sessionBindParams(sessionN1, DOOR_ID, EPOCH + 1);
    const socketN1 = new WebSocket(wsSessionUrl(httpBound.host, httpBound.port, bindN1));
    await waitForWebSocketOpen(socketN1);

    const inboundPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("inbound timeout")), 3000);
      socketN1.once("message", (data) => {
        clearTimeout(timer);
        const text = typeof data === "string" ? data : data.toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
    });

    wsServer.broadcastInbound({ text: "Active epoch inbound." }, "msg_active_epoch");
    const inbound = await inboundPromise;
    expect(inbound.type).toBe("inbound");
    expect((inbound.body as { text: string }).text).toBe("Active epoch inbound.");

    socketN1.close();
  });

  it("departure closes bound WebSocket with session_end", async () => {
    const soul = generateKeypair();
    const session = generateKeypair();
    const door = createDoor(soul.publicKey);
    httpServer = new HttpDoorServer({ door });
    const httpBound = await httpServer.start();
    wsServer = new WsDoorSessionServer({ door, server: httpServer.nodeServer });
    await wsServer.start();

    await door.attest(
      signAttestRequest(
        soul,
        session,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH,
          kind: "arrival",
          core: CORE,
          session_pubkey: encodePublicKey(session.publicKey),
          issued_at: ISSUED_AT
        },
        true
      )
    );

    const bind = sessionBindParams(session, DOOR_ID, EPOCH);
    const socket = new WebSocket(wsSessionUrl(httpBound.host, httpBound.port, bind));
    await waitForWebSocketOpen(socket);

    const sessionEndPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("session_end timeout")), 3000);
      socket.once("message", (data) => {
        clearTimeout(timer);
        const text = typeof data === "string" ? data : data.toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
    });

    await door.attest(
      signAttestRequest(
        soul,
        session,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH,
          kind: "departure",
          core: '{"type":"attestation","kind":"departure"}',
          session_pubkey: encodePublicKey(session.publicKey),
          issued_at: ISSUED_AT
        },
        false
      )
    );

    const sessionEnd = await sessionEndPromise;
    expect(sessionEnd.type).toBe("control");
    expect((sessionEnd.body as { action: string }).action).toBe("session_end");

    await waitForWebSocketClose(socket);
    expect(wsServer.getActiveClients().size).toBe(0);
  });
});
