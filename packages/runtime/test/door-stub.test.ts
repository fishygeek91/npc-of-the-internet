import {
  canonicalize,
  decodeSignature,
  encodePublicKey,
  encodeSignature,
  verify
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import {
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  DOOR_PROTOCOL_VERSION
} from "../src/session/types.js";
import type {
  AttestRequest,
  CosignCandidateShard,
  CosignRequest,
  OutboundFrame
} from "../src/session/types.js";
import { DoorStub, DoorStubError } from "./helpers/door-stub.js";
import { FakeClock } from "./helpers/fake-timer.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";

const DOOR_ID = "discord:g";
const EPOCH = 77;
const ISSUED_AT = "2026-07-20T15:04:05.123Z";
const CORE = '{"type":"attestation","kind":"arrival"}';
const MEMORY_CORE = '{"type":"memory","body":{"kind":"shard","text":"I remember the hall."}}';

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

function sampleShards(count: number): CosignCandidateShard[] {
  return Array.from({ length: count }, (_, index) => ({
    shard_id: `shard_${String(index + 1).padStart(2, "0")}`,
    text: `Memory shard ${String(index + 1)} from the residency.`
  }));
}

function signCosignReviewRequest(
  keyring: SingleKeyKeyring,
  fields: Omit<Extract<CosignRequest, { phase: "review" }>, "sig">
): Extract<CosignRequest, { phase: "review" }> {
  const sessionSigner = keyring.deriveSessionKey(fields.door_id, fields.epoch);
  const payload = cosignReviewSigningPayload(fields);
  return { ...fields, sig: encodeSignature(sessionSigner.sign(payload)) };
}

function signCosignCommitRequest(
  keyring: SingleKeyKeyring,
  fields: Omit<Extract<CosignRequest, { phase: "commit" }>, "sig">
): Extract<CosignRequest, { phase: "commit" }> {
  const sessionSigner = keyring.deriveSessionKey(fields.door_id, fields.epoch);
  const payload = cosignCommitSigningPayload(fields);
  return { ...fields, sig: encodeSignature(sessionSigner.sign(payload)) };
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
      core: CORE,
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

  it("cosign review approves all shards by default and rejects a second review", async () => {
    const stub = createStub();
    await establishArrival(stub, keyring, EPOCH);

    const shards = sampleShards(5);
    const reviewRequest = signCosignReviewRequest(keyring, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(sessionSigner.publicKey),
      shards,
      issued_at: ISSUED_AT
    });

    const reviewResponse = await stub.cosign(reviewRequest);

    expect(reviewResponse.phase).toBe("review");
    expect(reviewResponse.decisions).toHaveLength(5);
    expect(reviewResponse.decisions.every((decision) => decision.status === "approved")).toBe(true);

    await expect(stub.cosign(reviewRequest)).rejects.toThrow(DoorStubError);
    await expect(stub.cosign(reviewRequest)).rejects.toThrow(/epoch_closed/);
  });

  it("cosign review honors rejectShardIds and blocks commit for rejected shards", async () => {
    const shards = sampleShards(5);
    const rejectedId = shards[2].shard_id;
    const stub = new DoorStub({
      doorId: DOOR_ID,
      doorKeypair: DOOR,
      soulPublicKey: SOUL.publicKey,
      clock,
      rejectShardIds: new Set([rejectedId])
    });
    await establishArrival(stub, keyring, EPOCH);

    const reviewResponse = await stub.cosign(
      signCosignReviewRequest(keyring, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "review",
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        shards,
        issued_at: ISSUED_AT
      })
    );

    const rejected = reviewResponse.decisions.find((decision) => decision.shard_id === rejectedId);
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.reason).toBeDefined();

    const approvedId = shards[0].shard_id;
    const commitRequest = signCosignCommitRequest(keyring, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "commit",
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(sessionSigner.publicKey),
      shard_id: rejectedId,
      core: MEMORY_CORE,
      issued_at: ISSUED_AT
    });
    await expect(stub.cosign(commitRequest)).rejects.toThrow(DoorStubError);
    await expect(stub.cosign(commitRequest)).rejects.toThrow(/shard_not_approved/);

    const approvedCommit = await stub.cosign(
      signCosignCommitRequest(keyring, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "commit",
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        shard_id: approvedId,
        core: MEMORY_CORE,
        issued_at: ISSUED_AT
      })
    );
    expect(approvedCommit.phase).toBe("commit");
    expect(approvedCommit.shard_id).toBe(approvedId);
  });

  it("cosign commit signs core bytes verifiable under door pubkey", async () => {
    const stub = createStub();
    await establishArrival(stub, keyring, EPOCH);

    const shards = sampleShards(5);
    await stub.cosign(
      signCosignReviewRequest(keyring, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "review",
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        shards,
        issued_at: ISSUED_AT
      })
    );

    const shardId = shards[0].shard_id;
    const commitResponse = await stub.cosign(
      signCosignCommitRequest(keyring, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "commit",
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(sessionSigner.publicKey),
        shard_id: shardId,
        core: MEMORY_CORE,
        issued_at: ISSUED_AT
      })
    );

    const coreBytes = new TextEncoder().encode(MEMORY_CORE);
    const doorCosig = decodeSignature(commitResponse.door_cosig);
    expect(verify(coreBytes, doorCosig, DOOR.publicKey)).toBe(true);
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
        core: '{"type":"attestation","kind":"departure"}',
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
      DoorStubError
    );
    await expect(stub.heartbeat({ ...unsignedHeartbeat, sig: heartbeatSig })).rejects.toThrow(
      /epoch_closed/
    );
  });
});
