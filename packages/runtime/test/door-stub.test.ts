import { DoorError } from "@npc/door-sdk";
import {
  canonicalize,
  contentAddressSideBlob,
  encodePublicKey,
  encodeShardTextBlob,
  encodeSignature,
  verify,
  decodeSignature
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import { attestSigningPayload, DOOR_PROTOCOL_VERSION } from "../src/session/types.js";
import type { AttestRequest, OutboundFrame } from "../src/session/types.js";
import { DoorStub, ScriptedWitness } from "./helpers/door-stub.js";
import { FakeClock } from "./helpers/fake-timer.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";

const DOOR_ID = "discord:g";
const EPOCH = 77;
const ISSUED_AT = "2026-07-20T15:09:00.000Z";
/** Canonical OSP attestation core bound to `(door_id, epoch, kind)` — the Door rejects unbound cores. */
function attestCore(kind: AttestRequest["kind"], epoch: number, doorId = DOOR_ID): string {
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.2",
      seq: 1,
      prev: "bafyprev",
      type: "attestation",
      body: { kind, door_id: doorId, epoch },
      residency: `door:${doorId}/epoch:${String(epoch)}`
    })
  );
}

/** Canonical osp/0.2 `memory` shard core binding `text` by side-blob hash. */
async function memoryCore(text: string, epoch: number): Promise<string> {
  const { cid, hash } = await contentAddressSideBlob(encodeShardTextBlob(text));
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.2",
      seq: 2,
      prev: "bafyprev",
      type: "memory",
      body: { kind: "shard", text_cid: cid, text_hash: hash, distilled_at: ISSUED_AT },
      residency: `door:${DOOR_ID}/epoch:${String(epoch)}`
    })
  );
}

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

async function establishArrival(
  stub: DoorStub,
  keyring: SingleKeyKeyring,
  epoch: number
): Promise<void> {
  const sessionSigner = keyring.deriveSessionKey(DOOR_ID, epoch);
  const request = signAttestRequest(
    keyring,
    {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch,
      kind: "arrival",
      core: attestCore("arrival", epoch),
      session_pubkey: encodePublicKey(sessionSigner.publicKey),
      issued_at: ISSUED_AT
    },
    true
  );
  await stub.attest(request);
}

describe("DoorStub", () => {
  const clock = new FakeClock("2026-07-20T15:10:00.000Z");
  const keyring = new SingleKeyKeyring(SOUL.privateKey);
  const sessionSigner = keyring.deriveSessionKey(DOOR_ID, EPOCH);

  function createStub(witness?: ScriptedWitness | null): DoorStub {
    return new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock,
      ...(witness === undefined ? {} : { witness })
    });
  }

  async function memoryRequest(text: string): Promise<AttestRequest> {
    return signAttestRequest(
      keyring,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "memory",
        core: await memoryCore(text, EPOCH),
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        text,
        issued_at: ISSUED_AT
      },
      false
    );
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
        core: attestCore("arrival", EPOCH),
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
        core: attestCore("heartbeat", EPOCH),
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        issued_at: ISSUED_AT
      },
      false
    );

    await expect(stub.attest(request)).rejects.toThrow(DoorError);
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
        core: attestCore("arrival", EPOCH),
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
        core: attestCore("arrival", EPOCH),
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
        core: attestCore("arrival", EPOCH),
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
      DoorError
    );
    await expect(stub.heartbeat({ ...unsignedHeartbeat, sig: replaySig })).rejects.toThrow(
      /seq_replay/
    );
  });

  it("departure attest clears session and refuses heartbeat afterward", async () => {
    const stub = createStub();
    await establishArrival(stub, keyring, EPOCH);

    const departureRequest = signAttestRequest(
      keyring,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "departure",
        core: attestCore("departure", EPOCH),
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        issued_at: ISSUED_AT
      },
      false
    );
    await stub.attest(departureRequest);

    expect(stub.getActiveSessionPubkey()).toBeNull();

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

    await expect(stub.heartbeat({ ...unsignedHeartbeat, sig: heartbeatSig })).rejects.toThrow(
      DoorError
    );
    await expect(stub.heartbeat({ ...unsignedHeartbeat, sig: heartbeatSig })).rejects.toThrow(
      /epoch_closed/
    );
  });

  it("witnesses a memory: door_cosig over core verifies under the door pubkey", async () => {
    const witness = new ScriptedWitness();
    const stub = createStub(witness);
    expect(stub.witnessesMemories).toBe(true);
    await establishArrival(stub, keyring, EPOCH);

    const request = await memoryRequest("I remember the lantern light.");
    const response = await stub.attest(request);

    expect(response.kind).toBe("memory");
    expect(
      verify(
        new TextEncoder().encode(request.core),
        decodeSignature(response.door_cosig),
        DOOR.publicKey
      )
    ).toBe(true);
    expect(witness.texts("shard")).toEqual(["I remember the lantern light."]);
  });

  it("declines with witness_declined and a reason; an outage is witness_unavailable", async () => {
    const witness = new ScriptedWitness(() => ({ witnessed: false, reason: "private" }));
    const stub = createStub(witness);
    await establishArrival(stub, keyring, EPOCH);

    const declined = await stub.attest(await memoryRequest("A secret.")).catch((e: unknown) => e);
    expect(declined).toBeInstanceOf(DoorError);
    expect((declined as DoorError).code).toBe("witness_declined");
    expect((declined as DoorError).details).toEqual({ reason: "private" });

    witness.decide = () => "unavailable";
    const outage = await stub.attest(await memoryRequest("Later.")).catch((e: unknown) => e);
    expect((outage as DoorError).code).toBe("witness_unavailable");
  });

  it("without a witness the Door does not advertise attest.memory and refuses memories", async () => {
    const stub = createStub(null);
    expect(stub.witnessesMemories).toBe(false);
    const hello = await stub.hello({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(SOUL.publicKey)
    });
    expect(hello.capabilities).not.toContain("attest.memory");
    await establishArrival(stub, keyring, EPOCH);

    await expect(stub.attest(await memoryRequest("Anything."))).rejects.toThrow(/unsupported_kind/);
  });
});
