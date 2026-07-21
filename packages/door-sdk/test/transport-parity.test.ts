import {
  canonicalize,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { Door } from "../src/door.js";
import type { HostPolicy } from "../src/policy.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";
import type { AttestRequest, HeartbeatRequest, OutboundFrame } from "../src/schemas.js";
import {
  attestSigningPayload,
  generateDoorKeypair,
  outboundSigningPayload,
  sessionBindSigningPayload
} from "../src/signing.js";
import { HttpDoorServer } from "../src/transports/http.js";
import { InProcessDoorConnection } from "../src/transports/in-process.js";
import { WS_SESSION_BIND_FAILED, WsDoorSessionServer } from "../src/transports/ws.js";

const DOOR_ID = "discord:parity";
const EPOCH = 42;
const ISSUED_AT = "2026-07-20T15:04:05.123Z";
const RECEIVED_AT = "2026-07-20T15:10:00.000Z";
const CORE = '{"type":"attestation","kind":"arrival"}';

/** Injectable clock for deterministic timestamps. */
class FakeClock {
  constructor(private readonly fixed: string) {}

  now(): string {
    return this.fixed;
  }
}

const defaultPolicy: HostPolicy = {
  community: {
    name: "Parity Guild",
    description: "Transport parity test community.",
    platform: "discord",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
};

type TransportTestEnv = {
  soul: Ed25519Keypair;
  session: Ed25519Keypair;
  doorKeypair: Ed25519Keypair;
  inProcessDoor: Door;
  httpDoor: Door;
  inProcess: InProcessDoorConnection;
  httpServer: HttpDoorServer;
  httpBaseUrl: string;
  wsServer: WsDoorSessionServer;
  wsUrl: string;
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

async function createTransportTestEnv(): Promise<TransportTestEnv> {
  const soul = generateKeypair();
  const session = generateKeypair();
  const doorKeypair = generateDoorKeypair();
  const clock = new FakeClock(RECEIVED_AT);
  const doorOptions = {
    doorId: DOOR_ID,
    doorKeypair,
    soulPublicKey: soul.publicKey,
    clock,
    policy: defaultPolicy
  };

  const inProcessDoor = new Door(doorOptions);
  const httpDoor = new Door(doorOptions);
  const inProcess = new InProcessDoorConnection(inProcessDoor);
  const httpServer = new HttpDoorServer({ door: httpDoor });
  const httpInfo = await httpServer.start();
  const wsServer = new WsDoorSessionServer({ door: inProcessDoor });
  const wsInfo = await wsServer.start();

  return {
    soul,
    session,
    doorKeypair,
    inProcessDoor,
    httpDoor,
    inProcess,
    httpServer,
    httpBaseUrl: httpInfo.baseUrl,
    wsServer,
    wsUrl: wsInfo.url
  };
}

describe("transport parity", () => {
  let env: TransportTestEnv;

  beforeAll(async () => {
    env = await createTransportTestEnv();
  });

  afterAll(async () => {
    await env.wsServer.stop();
    await env.httpServer.stop();
  });

  it("arrival attest door_cosig matches between in-process and HTTP", async () => {
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
    const httpResponse = await postJson(env.httpBaseUrl, "/door/attest", request);

    expect(httpResponse.status).toBe(200);
    expect(inProcessResponse.door_cosig).toBe(
      (httpResponse.body as { door_cosig: string }).door_cosig
    );
  });

  it("heartbeat seq=1 matches between in-process and HTTP", async () => {
    const arrival = signAttestRequest(
      env.soul,
      env.session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH + 1,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(env.session.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await env.inProcess.attest(arrival);
    await postJson(env.httpBaseUrl, "/door/attest", arrival);

    const heartbeat = signHeartbeatRequest(env.session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: EPOCH + 1,
      session_pubkey: encodePublicKey(env.session.publicKey),
      seq: 1,
      issued_at: ISSUED_AT
    });

    const inProcessResponse = await env.inProcess.heartbeat(heartbeat);
    const httpResponse = await postJson(env.httpBaseUrl, "/door/heartbeat", heartbeat);

    expect(httpResponse.status).toBe(200);
    expect(inProcessResponse.accepted).toBe(true);
    expect(inProcessResponse.seq).toBe(1);
    expect((httpResponse.body as { accepted: boolean }).accepted).toBe(true);
    expect((httpResponse.body as { seq: number }).seq).toBe(1);
  });

  it("WebSocket accepts ping/pong and signed outbound frames", async () => {
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

    const bind = sessionBindParams(env.session, DOOR_ID, epoch);
    const query = new URLSearchParams({
      door_id: bind.door_id,
      epoch: String(bind.epoch),
      session_pubkey: bind.session_pubkey,
      session_sig: bind.session_sig
    });

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${env.wsUrl}?${query.toString()}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
      socket.once("close", (code) => reject(new Error(`unexpected close ${String(code)}`)));
    });

    const pingFrame = {
      type: "control",
      door_id: DOOR_ID,
      epoch,
      msg_id: "ctrl_ping_parity",
      issued_at: ISSUED_AT,
      body: { action: "ping" }
    };

    const pongPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pong timeout")), 3000);
      ws.once("message", (data) => {
        clearTimeout(timer);
        const text = typeof data === "string" ? data : data.toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      });
    });

    ws.send(JSON.stringify(pingFrame));
    const pong = await pongPromise;
    expect(pong.body).toEqual({ action: "pong" });
    expect(pong.sig).toBeDefined();

    const outbound = signOutboundFrame(env.session, {
      type: "outbound",
      door_id: DOOR_ID,
      epoch,
      msg_id: "msg_parity_out",
      issued_at: ISSUED_AT,
      body: { text: "Hello over WebSocket." }
    });

    const stayOpen = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 300);
      ws.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`socket closed unexpectedly with code ${String(code)}`));
      });
    });

    ws.send(JSON.stringify(outbound));
    await stayOpen;
    ws.close();
  });

  it("WebSocket rejects bad session bind with close code 4401", async () => {
    const epoch = EPOCH + 3;
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

    const wrongSession = generateKeypair();
    const bind = sessionBindParams(wrongSession, DOOR_ID, epoch);
    const query = new URLSearchParams({
      door_id: bind.door_id,
      epoch: String(bind.epoch),
      session_pubkey: bind.session_pubkey,
      session_sig: bind.session_sig
    });

    const closeCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${env.wsUrl}?${query.toString()}`);
      socket.once("close", (code) => resolve(code));
    });

    expect(closeCode).toBe(WS_SESSION_BIND_FAILED);
  });
});
