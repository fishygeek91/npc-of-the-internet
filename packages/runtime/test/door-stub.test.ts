import { canonicalize, encodePublicKey, encodeSignature } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { attestSigningPayload, DOOR_PROTOCOL_VERSION } from "../src/session/types.js";
import type { AttestRequest, OutboundFrame } from "../src/session/types.js";
import { DoorStub, DoorStubError } from "./helpers/door-stub.js";
import { FakeClock } from "./helpers/fake-timer.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";

const DOOR_ID = "discord:g";
const EPOCH = 77;
const ISSUED_AT = "2026-07-20T15:04:05.123Z";
const CORE = '{"type":"attestation","kind":"arrival"}';

function signAttestRequest(
  keyring: SingleKeyKeyring,
  fields: Omit<AttestRequest, "sig">,
  useSoulKey: boolean
): AttestRequest {
  const payload = attestSigningPayload(fields);
  const signature = useSoulKey
    ? keyring.signWithSoulKey(payload)
    : keyring.deriveSessionKey(fields.door_id, fields.epoch).sign(payload);
  return { ...fields, sig: encodeSignature(signature) };
}

function signOutboundFrame(
  keyring: SingleKeyKeyring,
  frame: Omit<OutboundFrame, "sig">
): OutboundFrame {
  const sessionSigner = keyring.deriveSessionKey(frame.door_id, frame.epoch);
  const payload = canonicalize(frame);
  return { ...frame, sig: encodeSignature(sessionSigner.sign(payload)) };
}

describe("DoorStub", () => {
  const clock = new FakeClock("2026-07-20T15:10:00.000Z");
  const keyring = new SingleKeyKeyring(SOUL.privateKey);
  const sessionSigner = keyring.deriveSessionKey(DOOR_ID, EPOCH);

  function createStub(): DoorStub {
    return new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock
    });
  }

  it("accepts arrival attest with correct soul signature and sets session", async () => {
    const stub = createStub();
    const request = signAttestRequest(
      keyring,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );

    const response = await stub.attest(request);

    expect(response.door_id).toBe(DOOR_ID);
    expect(response.epoch).toBe(EPOCH);
    expect(response.kind).toBe("arrival");
    expect(response.door_cosig.length).toBeGreaterThan(0);
    expect(response.door_sig.length).toBeGreaterThan(0);
    expect(stub.getActiveSessionPubkey()).toBe(encodePublicKey(sessionSigner.publicKey));
  });

  it("rejects heartbeat attest when no arrival established session", async () => {
    const stub = createStub();
    const request = signAttestRequest(
      keyring,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "heartbeat",
        core: CORE,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        issued_at: ISSUED_AT
      },
      false
    );

    await expect(stub.attest(request)).rejects.toThrow(DoorStubError);
    await expect(stub.attest(request)).rejects.toThrow(/no active session/);
  });

  it("verifies good outbound frames and rejects tampered text", async () => {
    const stub = createStub();
    const arrivalRequest = signAttestRequest(
      keyring,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await stub.attest(arrivalRequest);

    const outbound = signOutboundFrame(keyring, {
      type: "outbound",
      door_id: DOOR_ID,
      epoch: EPOCH,
      msg_id: "msg_test_01",
      issued_at: ISSUED_AT,
      body: { text: "Hello from the Wanderer." }
    });

    expect(stub.verifyOutbound(outbound)).toBe(true);

    const tampered: OutboundFrame = {
      ...outbound,
      body: { ...outbound.body, text: "Tampered message." }
    };
    expect(stub.verifyOutbound(tampered)).toBe(false);
  });

  it("rejects outbound signed with session key from wrong epoch", async () => {
    const stub = createStub();
    const arrivalRequest = signAttestRequest(
      keyring,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await stub.attest(arrivalRequest);

    const wrongEpochSigner = keyring.deriveSessionKey(DOOR_ID, EPOCH + 1);
    const unsigned = {
      type: "outbound" as const,
      door_id: DOOR_ID,
      epoch: EPOCH,
      msg_id: "msg_wrong_epoch_key",
      issued_at: ISSUED_AT,
      body: { text: "Signed with wrong epoch session key." }
    };
    const wrongKeyOutbound: OutboundFrame = {
      ...unsigned,
      sig: encodeSignature(wrongEpochSigner.sign(canonicalize(unsigned)))
    };

    expect(stub.verifyOutbound(wrongKeyOutbound)).toBe(false);
  });

  it("rejects heartbeat seq replay", async () => {
    const stub = createStub();
    const arrivalRequest = signAttestRequest(
      keyring,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );
    await stub.attest(arrivalRequest);

    const unsignedHeartbeat = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(sessionSigner.publicKey),
      seq: 1,
      issued_at: ISSUED_AT
    };
    const heartbeatPayload = canonicalize(unsignedHeartbeat);
    const heartbeatSig = encodeSignature(sessionSigner.sign(heartbeatPayload));

    await stub.heartbeat({ ...unsignedHeartbeat, sig: heartbeatSig });

    const replaySig = encodeSignature(sessionSigner.sign(heartbeatPayload));
    await expect(stub.heartbeat({ ...unsignedHeartbeat, sig: replaySig })).rejects.toThrow(
      DoorStubError
    );
    await expect(stub.heartbeat({ ...unsignedHeartbeat, sig: replaySig })).rejects.toThrow(
      /seq_replay/
    );
  });
});
