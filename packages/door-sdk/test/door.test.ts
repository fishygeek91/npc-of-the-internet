import {
  canonicalize,
  corePayload,
  createRecord,
  decodeSignature,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  OSP_SPEC,
  sign,
  verify,
  verifyRecord,
  type Ed25519Keypair
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { Door } from "../src/door.js";
import { DoorError } from "../src/errors.js";
import type { HostPolicy } from "../src/policy.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";
import type {
  AttestRequest,
  CosignCandidateShard,
  CosignRequest,
  OutboundFrame
} from "../src/schemas.js";
import {
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  generateDoorKeypair,
  helloResponseSigningPayload,
  sessionBindSigningPayload,
  verifyCanonical,
  verifyDoorCosig
} from "../src/signing.js";

const DOOR_ID = "discord:g";
const EPOCH = 77;
const ISSUED_AT = "2026-07-20T15:04:05.123Z";
const RECEIVED_AT = "2026-07-20T15:10:00.000Z";
const PREV_CID = "bagu" + "a".repeat(57);
const RESIDENCY = `door:${DOOR_ID}/epoch:${String(EPOCH)}`;

const CORE = '{"type":"attestation","kind":"arrival"}';
const MEMORY_CORE = '{"type":"memory","body":{"kind":"shard","text":"I remember the hall."}}';

/** Injectable clock for deterministic timestamps. */
class FakeClock {
  constructor(private readonly fixed: string) {}

  now(): string {
    return this.fixed;
  }
}

const defaultPolicy: HostPolicy = {
  community: {
    name: "Test Guild",
    description: "A test community for door-sdk.",
    platform: "discord",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
};

function createDoor(options?: {
  policy?: HostPolicy;
  doorKeypair?: Ed25519Keypair;
  soulPublicKey?: Uint8Array;
}): { door: Door; doorKeypair: Ed25519Keypair; soul: Ed25519Keypair } {
  const soul = generateKeypair();
  const doorKeypair = options?.doorKeypair ?? generateDoorKeypair();
  const door = new Door({
    doorId: DOOR_ID,
    doorKeypair,
    soulPublicKey: options?.soulPublicKey ?? soul.publicKey,
    clock: new FakeClock(RECEIVED_AT),
    policy: options?.policy ?? defaultPolicy
  });
  return { door, doorKeypair, soul };
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

function signOutboundFrame(
  session: Ed25519Keypair,
  frame: Omit<OutboundFrame, "sig">
): OutboundFrame {
  const payload = canonicalize(frame);
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

function signCosignCommitRequest(
  session: Ed25519Keypair,
  fields: Omit<Extract<CosignRequest, { phase: "commit" }>, "sig">
): Extract<CosignRequest, { phase: "commit" }> {
  const payload = cosignCommitSigningPayload(fields);
  return { ...fields, sig: encodeSignature(sign(payload, session.privateKey)) };
}

async function establishArrival(
  door: Door,
  soul: Ed25519Keypair,
  session: Ed25519Keypair,
  epoch: number
): Promise<void> {
  const request = signAttestRequest(
    soul,
    session,
    {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch,
      kind: "arrival",
      core: CORE,
      session_pubkey: encodePublicKey(session.publicKey),
      issued_at: ISSUED_AT
    },
    true
  );
  await door.attest(request);
}

describe("Door", () => {
  const soul = generateKeypair();
  const session = generateKeypair();

  function createTestDoor(policy?: HostPolicy): Door {
    return createDoor({ policy, soulPublicKey: soul.publicKey }).door;
  }

  it("hello returns signed response; bad protocol version fails", async () => {
    const { door, doorKeypair } = createDoor({ soulPublicKey: soul.publicKey });
    const response = await door.hello({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(soul.publicKey)
    });

    expect(response.door_id).toBe(DOOR_ID);
    expect(response.door_pubkey).toBe(encodePublicKey(doorKeypair.publicKey));
    expect(response.active_epoch).toBeNull();
    expect(response.capabilities).toEqual(defaultPolicy.capabilities);
    expect(response.community).toEqual(defaultPolicy.community);
    expect(
      verifyCanonical(
        {
          protocol_version: response.protocol_version,
          door_id: response.door_id,
          door_pubkey: response.door_pubkey,
          active_epoch: response.active_epoch,
          capabilities: response.capabilities,
          community: response.community,
          issued_at: response.issued_at
        },
        response.sig,
        doorKeypair.publicKey
      )
    ).toBe(true);
    expect(
      verify(
        helloResponseSigningPayload({
          protocol_version: response.protocol_version,
          door_id: response.door_id,
          door_pubkey: response.door_pubkey,
          active_epoch: response.active_epoch,
          capabilities: response.capabilities,
          community: response.community,
          issued_at: response.issued_at
        }),
        decodeSignature(response.sig),
        doorKeypair.publicKey
      )
    ).toBe(true);

    await expect(
      door.hello({
        protocol_version: "door/0.0",
        soul_pubkey: encodePublicKey(soul.publicKey)
      })
    ).rejects.toMatchObject({ code: "unsupported_version" });
  });

  it("rejecting acceptArrival does not install session state (not_hosting)", async () => {
    let allowArrival = true;
    const door = createTestDoor({
      ...defaultPolicy,
      acceptArrival: () => {
        if (!allowArrival) {
          throw new Error("guild is full");
        }
      }
    });
    const rejectedSession = generateKeypair();

    await establishArrival(door, soul, session, EPOCH);
    expect(door.getActiveSessionPubkey()).toBe(encodePublicKey(session.publicKey));

    allowArrival = false;
    const rejectedArrival = signAttestRequest(
      soul,
      rejectedSession,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH + 1,
        kind: "arrival",
        core: CORE,
        session_pubkey: encodePublicKey(rejectedSession.publicKey),
        issued_at: ISSUED_AT
      },
      true
    );

    await expect(door.attest(rejectedArrival)).rejects.toMatchObject({
      code: "not_hosting",
      httpStatus: 403
    });
    expect(door.getActiveSessionPubkey()).toBe(encodePublicKey(session.publicKey));
    expect(door.getActiveEpoch()).toBe(EPOCH);

    const rejectedHeartbeat = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: EPOCH + 1,
      session_pubkey: encodePublicKey(rejectedSession.publicKey),
      seq: 1,
      issued_at: ISSUED_AT
    };
    const rejectedHeartbeatSig = encodeSignature(
      sign(canonicalize(rejectedHeartbeat), rejectedSession.privateKey)
    );
    await expect(
      door.heartbeat({ ...rejectedHeartbeat, sig: rejectedHeartbeatSig })
    ).rejects.toMatchObject({ code: "session_invalid" });
  });

  it("departure attest with wrong epoch returns epoch_mismatch", async () => {
    const door = createTestDoor();
    await establishArrival(door, soul, session, EPOCH);

    const staleDeparture = signAttestRequest(
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
    );

    await expect(door.attest(staleDeparture)).rejects.toMatchObject({
      code: "epoch_mismatch",
      httpStatus: 409
    });
    expect(door.getActiveSessionPubkey()).toBe(encodePublicKey(session.publicKey));
  });

  it("arrival then heartbeat then departure lifecycle", async () => {
    const door = createTestDoor();
    await establishArrival(door, soul, session, EPOCH);

    expect(door.getActiveSessionPubkey()).toBe(encodePublicKey(session.publicKey));
    expect(door.getActiveEpoch()).toBe(EPOCH);

    const helloAfterArrival = await door.hello({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(soul.publicKey)
    });
    expect(helloAfterArrival.active_epoch).toBe(EPOCH);

    const unsignedHeartbeat = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      seq: 1,
      issued_at: ISSUED_AT
    };
    const heartbeatSig = encodeSignature(sign(canonicalize(unsignedHeartbeat), session.privateKey));
    const heartbeatResponse = await door.heartbeat({ ...unsignedHeartbeat, sig: heartbeatSig });
    expect(heartbeatResponse.accepted).toBe(true);
    expect(heartbeatResponse.seq).toBe(1);

    const departureRequest = signAttestRequest(
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
    );
    await door.attest(departureRequest);

    expect(door.getActiveSessionPubkey()).toBeNull();
    expect(door.getActiveEpoch()).toBeNull();

    await expect(
      door.heartbeat({ ...unsignedHeartbeat, seq: 2, sig: heartbeatSig })
    ).rejects.toMatchObject({ code: "epoch_closed" });
    await expect(
      door.heartbeat({ ...unsignedHeartbeat, seq: 2, sig: heartbeatSig })
    ).rejects.toThrow(/epoch_closed/);
  });

  it("rejects heartbeat attest when no arrival established session", async () => {
    const door = createTestDoor();
    const request = signAttestRequest(
      soul,
      session,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "heartbeat",
        core: CORE,
        session_pubkey: encodePublicKey(session.publicKey),
        issued_at: ISSUED_AT
      },
      false
    );

    await expect(door.attest(request)).rejects.toBeInstanceOf(DoorError);
    await expect(door.attest(request)).rejects.toMatchObject({ code: "session_invalid" });
    await expect(door.attest(request)).rejects.toThrow(/no active session/);
  });

  it("wrong soul/session sig → signature_invalid", async () => {
    const door = createTestDoor();
    const wrongSoul = generateKeypair();

    const badArrival = signAttestRequest(
      wrongSoul,
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
    );
    await expect(door.attest(badArrival)).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(door.attest(badArrival)).rejects.toThrow(/invalid soul signature/);

    await establishArrival(door, soul, session, EPOCH);

    const wrongSession = generateKeypair();
    const badHeartbeatAttest = signAttestRequest(
      soul,
      wrongSession,
      {
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: EPOCH,
        kind: "heartbeat",
        core: CORE,
        session_pubkey: encodePublicKey(session.publicKey),
        issued_at: ISSUED_AT
      },
      false
    );
    await expect(door.attest(badHeartbeatAttest)).rejects.toMatchObject({
      code: "signature_invalid"
    });
    await expect(door.attest(badHeartbeatAttest)).rejects.toThrow(/invalid session signature/);
  });

  it("rejects heartbeat seq replay", async () => {
    const door = createTestDoor();
    await establishArrival(door, soul, session, EPOCH);

    const unsignedHeartbeat = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      seq: 1,
      issued_at: ISSUED_AT
    };
    const heartbeatPayload = canonicalize(unsignedHeartbeat);
    const heartbeatSig = encodeSignature(sign(heartbeatPayload, session.privateKey));

    await door.heartbeat({ ...unsignedHeartbeat, sig: heartbeatSig });

    const replaySig = encodeSignature(sign(heartbeatPayload, session.privateKey));
    await expect(door.heartbeat({ ...unsignedHeartbeat, sig: replaySig })).rejects.toBeInstanceOf(
      DoorError
    );
    await expect(door.heartbeat({ ...unsignedHeartbeat, sig: replaySig })).rejects.toMatchObject({
      code: "seq_replay"
    });
    await expect(door.heartbeat({ ...unsignedHeartbeat, sig: replaySig })).rejects.toThrow(
      /seq_replay/
    );
  });

  it("cosign review then commit; door_cosig verifies; second review → epoch_closed", async () => {
    const { door, doorKeypair } = createDoor({ soulPublicKey: soul.publicKey });
    await establishArrival(door, soul, session, EPOCH);

    const shards = sampleShards(5);
    const reviewRequest = signCosignReviewRequest(session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      shards,
      issued_at: ISSUED_AT
    });

    const reviewResponse = await door.cosign(reviewRequest);
    expect(reviewResponse.phase).toBe("review");
    expect(reviewResponse.decisions).toHaveLength(5);
    expect(reviewResponse.decisions.every((decision) => decision.status === "approved")).toBe(true);

    await expect(door.cosign(reviewRequest)).rejects.toBeInstanceOf(DoorError);
    await expect(door.cosign(reviewRequest)).rejects.toMatchObject({ code: "epoch_closed" });
    await expect(door.cosign(reviewRequest)).rejects.toThrow(/epoch_closed/);

    const shardId = shards[0].shard_id;
    const commitResponse = await door.cosign(
      signCosignCommitRequest(session, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "commit",
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(session.publicKey),
        shard_id: shardId,
        core: MEMORY_CORE,
        issued_at: ISSUED_AT
      })
    );

    expect(commitResponse.phase).toBe("commit");
    expect(verifyDoorCosig(MEMORY_CORE, commitResponse.door_cosig, doorKeypair.publicKey)).toBe(
      true
    );
    const coreBytes = new TextEncoder().encode(MEMORY_CORE);
    expect(
      verify(coreBytes, decodeSignature(commitResponse.door_cosig), doorKeypair.publicKey)
    ).toBe(true);
  });

  it("commit before review → review_pending", async () => {
    const door = createTestDoor();
    await establishArrival(door, soul, session, EPOCH);

    const commitRequest = signCosignCommitRequest(session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "commit",
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      shard_id: "shard_01",
      core: MEMORY_CORE,
      issued_at: ISSUED_AT
    });

    await expect(door.cosign(commitRequest)).rejects.toMatchObject({ code: "review_pending" });
    await expect(door.cosign(commitRequest)).rejects.toThrow(/review_pending/);
  });

  it("cosign review honors reject policy and blocks commit for rejected shards", async () => {
    const shards = sampleShards(5);
    const rejectedId = shards[2].shard_id;
    const door = createDoor({
      soulPublicKey: soul.publicKey,
      policy: {
        ...defaultPolicy,
        decideShard: (shard) => (shard.shard_id === rejectedId ? "rejected" : "approved")
      }
    }).door;
    await establishArrival(door, soul, session, EPOCH);

    const reviewResponse = await door.cosign(
      signCosignReviewRequest(session, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "review",
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(session.publicKey),
        shards,
        issued_at: ISSUED_AT
      })
    );

    const rejected = reviewResponse.decisions.find((decision) => decision.shard_id === rejectedId);
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.reason).toBeDefined();

    const approvedId = shards[0].shard_id;
    const commitRequest = signCosignCommitRequest(session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "commit",
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      shard_id: rejectedId,
      core: MEMORY_CORE,
      issued_at: ISSUED_AT
    });
    await expect(door.cosign(commitRequest)).rejects.toMatchObject({ code: "shard_not_approved" });
    await expect(door.cosign(commitRequest)).rejects.toThrow(/shard_not_approved/);

    const approvedCommit = await door.cosign(
      signCosignCommitRequest(session, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "commit",
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(session.publicKey),
        shard_id: approvedId,
        core: MEMORY_CORE,
        issued_at: ISSUED_AT
      })
    );
    expect(approvedCommit.phase).toBe("commit");
    expect(approvedCommit.shard_id).toBe(approvedId);
  });

  it("verifies good outbound frames and rejects tampered text", async () => {
    const door = createTestDoor();
    await establishArrival(door, soul, session, EPOCH);

    const outbound = signOutboundFrame(session, {
      type: "outbound",
      door_id: DOOR_ID,
      epoch: EPOCH,
      msg_id: "msg_test_01",
      issued_at: ISSUED_AT,
      body: { text: "Hello from the Wanderer." }
    });

    expect(door.verifyOutbound(outbound)).toBe(true);
    door.handleOutbound(outbound);

    const tampered: OutboundFrame = {
      ...outbound,
      body: { ...outbound.body, text: "Tampered message." }
    };
    expect(door.verifyOutbound(tampered)).toBe(false);
    await expect(() => door.handleOutbound(tampered)).toThrow(DoorError);
    await expect(() => door.handleOutbound(tampered)).toThrow(/signature_invalid/);
  });

  it("bindSession succeeds with valid session_sig and fails otherwise", async () => {
    const door = createTestDoor();
    await establishArrival(door, soul, session, EPOCH);

    const bindPayload = sessionBindSigningPayload({
      door_id: DOOR_ID,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey)
    });
    const sessionSig = encodeSignature(sign(bindPayload, session.privateKey));

    expect(() =>
      door.bindSession({
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(session.publicKey),
        session_sig: sessionSig
      })
    ).not.toThrow();

    const wrongSession = generateKeypair();
    const badSig = encodeSignature(sign(bindPayload, wrongSession.privateKey));
    await expect(
      Promise.resolve().then(() =>
        door.bindSession({
          door_id: DOOR_ID,
          epoch: EPOCH,
          session_pubkey: encodePublicKey(session.publicKey),
          session_sig: badSig
        })
      )
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("ping control frame returns signed pong", async () => {
    const { door, doorKeypair } = createDoor({ soulPublicKey: soul.publicKey });

    const pong = door.handleControl({
      type: "control",
      door_id: DOOR_ID,
      epoch: EPOCH,
      msg_id: "ctrl_ping_01",
      issued_at: ISSUED_AT,
      body: { action: "ping" }
    });

    expect(pong).not.toBeNull();
    expect(pong?.body.action).toBe("pong");
    expect(pong?.sig).toBeDefined();
    if (pong?.sig !== undefined) {
      expect(
        verifyCanonical(
          {
            type: pong.type,
            door_id: pong.door_id,
            epoch: pong.epoch,
            msg_id: pong.msg_id,
            issued_at: pong.issued_at,
            body: pong.body
          },
          pong.sig,
          doorKeypair.publicKey
        )
      ).toBe(true);
    }
  });

  it("arrival attest door_cosig verifies on a soulchain attestation record", async () => {
    const { door, doorKeypair, soul: doorSoul } = createDoor();
    const sessionKey = generateKeypair();

    const fields = {
      seq: 1,
      prev: PREV_CID,
      type: "attestation" as const,
      body: {
        kind: "arrival" as const,
        pop_version: "pop/0.1" as const,
        door_id: DOOR_ID,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(sessionKey.publicKey),
        at: ISSUED_AT
      },
      residency: RESIDENCY
    };
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC,
          ...fields
        })
      )
    );

    const attestResponse = await door.attest(
      signAttestRequest(
        doorSoul,
        sessionKey,
        {
          protocol_version: DOOR_PROTOCOL_VERSION,
          door_id: DOOR_ID,
          epoch: EPOCH,
          kind: "arrival",
          core,
          session_pubkey: encodePublicKey(sessionKey.publicKey),
          issued_at: ISSUED_AT
        },
        true
      )
    );

    const { record } = await createRecord({
      ...fields,
      cosigners: [attestResponse.door_cosig],
      soulPrivateKey: doorSoul.privateKey
    });

    const verifyResult = await verifyRecord(record, {
      soulPublicKey: doorSoul.publicKey,
      doorPublicKeys: [doorKeypair.publicKey]
    });
    expect(verifyResult.record.type).toBe("attestation");
    expect(verifyDoorCosig(core, attestResponse.door_cosig, doorKeypair.publicKey)).toBe(true);
  });
});
