import {
  canonicalize,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { Door } from "../src/door.js";
import type { HostPolicy } from "../src/policy.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";
import type { AttestRequest, HeartbeatRequest } from "../src/schemas.js";
import { attestSigningPayload, generateDoorKeypair } from "../src/signing.js";
import { HttpDoorServer } from "../src/transports/http.js";
import { WsDoorSessionServer } from "../src/transports/ws.js";

const DOOR_ID = "discord:http";
const EPOCH = 11;
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
