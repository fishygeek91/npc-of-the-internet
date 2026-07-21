import { encodePublicKey, encodeSignature, generateKeypair, sign } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import {
  AttestRequestSchema,
  CandidateShardSchema,
  ControlFrameSchema,
  CosignRequestSchema,
  DOOR_PROTOCOL_VERSION,
  ErrorFrameSchema,
  HeartbeatRequestSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  InboundFrameSchema,
  OutboundFrameSchema
} from "../src/schemas.js";

const ISSUED_AT = "2026-07-20T15:04:05.123Z";
const DOOR_ID = "discord:123456789012345678";

function makeKeyMaterial() {
  const soul = generateKeypair();
  const door = generateKeypair();
  const session = generateKeypair();
  return {
    soulPubkey: encodePublicKey(soul.publicKey),
    doorPubkey: encodePublicKey(door.publicKey),
    sessionPubkey: encodePublicKey(session.publicKey),
    sessionPrivateKey: session.privateKey
  };
}

function makeShards(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    shard_id: `shard_${String(index + 1)}`,
    text: `Memory shard ${String(index + 1)}`
  }));
}

describe("door-sdk schemas", () => {
  const keys = makeKeyMaterial();

  it("accepts hello request/response fixtures", () => {
    const helloRequest = HelloRequestSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: keys.soulPubkey,
      client: "npc-runtime/0.1.0"
    });
    expect(helloRequest.protocol_version).toBe("door/0.1");

    const helloResponse = HelloResponseSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      door_pubkey: keys.doorPubkey,
      active_epoch: null,
      capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"],
      community: {
        name: "Test Guild",
        description: "A test community",
        platform: "discord",
        invitation_required: false
      },
      issued_at: ISSUED_AT,
      sig: encodeSignature(sign(new Uint8Array([1, 2, 3]), generateKeypair().privateKey))
    });
    expect(helloResponse.door_id).toBe(DOOR_ID);
  });

  it("accepts attest, heartbeat, and cosign fixtures", () => {
    const attest = AttestRequestSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: 77,
      kind: "arrival",
      core: '{"spec":"osp/0.1","seq":2,"prev":"bafy","type":"attestation","body":{},"residency":"door:discord:123456789012345678/epoch:77"}',
      session_pubkey: keys.sessionPubkey,
      issued_at: ISSUED_AT,
      sig: encodeSignature(sign(new Uint8Array([4, 5, 6]), generateKeypair().privateKey))
    });
    expect(attest.kind).toBe("arrival");

    const heartbeat = HeartbeatRequestSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: keys.sessionPubkey,
      seq: 1,
      issued_at: ISSUED_AT,
      sig: encodeSignature(sign(new Uint8Array([7, 8, 9]), generateKeypair().privateKey))
    });
    expect(heartbeat.seq).toBe(1);

    const cosignReview = CosignRequestSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: keys.sessionPubkey,
      shards: makeShards(5),
      issued_at: ISSUED_AT,
      sig: encodeSignature(sign(new Uint8Array([10, 11, 12]), generateKeypair().privateKey))
    });
    expect(cosignReview.phase).toBe("review");

    const cosignCommit = CosignRequestSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "commit",
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: keys.sessionPubkey,
      shard_id: "shard_1",
      core: '{"spec":"osp/0.1","seq":10,"prev":"bafy2","type":"memory","body":{"text":"I remember"},"residency":"door:discord:123456789012345678/epoch:77"}',
      issued_at: ISSUED_AT,
      sig: encodeSignature(sign(new Uint8Array([13, 14, 15]), generateKeypair().privateKey))
    });
    expect(cosignCommit.phase).toBe("commit");
  });

  it("accepts inbound, outbound, control, and error frame fixtures", () => {
    const inbound = InboundFrameSchema.parse({
      type: "inbound",
      door_id: DOOR_ID,
      epoch: 77,
      msg_id: "msg_in_1",
      issued_at: ISSUED_AT,
      body: {
        text: "Hello Wanderer",
        author_id: "user_1"
      }
    });
    expect(inbound.type).toBe("inbound");

    const outbound = OutboundFrameSchema.parse({
      type: "outbound",
      door_id: DOOR_ID,
      epoch: 77,
      msg_id: "msg_out_1",
      issued_at: ISSUED_AT,
      body: {
        text: "Hello community"
      },
      sig: encodeSignature(sign(new Uint8Array([16, 17, 18]), generateKeypair().privateKey))
    });
    expect(outbound.type).toBe("outbound");

    const control = ControlFrameSchema.parse({
      type: "control",
      door_id: DOOR_ID,
      epoch: 77,
      msg_id: "msg_ctrl_1",
      issued_at: ISSUED_AT,
      body: {
        action: "ping"
      }
    });
    expect(control.body.action).toBe("ping");

    const errorFrame = ErrorFrameSchema.parse({
      type: "error",
      door_id: DOOR_ID,
      epoch: 77,
      msg_id: "msg_err_1",
      issued_at: ISSUED_AT,
      body: {
        error: {
          code: "session_invalid",
          message: "No active session"
        },
        related_msg_id: "msg_out_1"
      }
    });
    expect(errorFrame.body.error.code).toBe("session_invalid");
  });

  it("rejects door_id values with a door: prefix", () => {
    expect(() =>
      AttestRequestSchema.parse({
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: "door:discord:123",
        epoch: 77,
        kind: "arrival",
        core: "{}",
        session_pubkey: keys.sessionPubkey,
        issued_at: ISSUED_AT,
        sig: encodeSignature(sign(new Uint8Array([1]), generateKeypair().privateKey))
      })
    ).toThrow();
  });

  it("rejects epoch 0", () => {
    expect(() =>
      HeartbeatRequestSchema.parse({
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: 0,
        session_pubkey: keys.sessionPubkey,
        seq: 1,
        issued_at: ISSUED_AT,
        sig: encodeSignature(sign(new Uint8Array([1]), generateKeypair().privateKey))
      })
    ).toThrow();
  });

  it("rejects cosign review shard counts outside 5–20", () => {
    const base = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review" as const,
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: keys.sessionPubkey,
      issued_at: ISSUED_AT,
      sig: encodeSignature(sign(new Uint8Array([1]), generateKeypair().privateKey))
    };

    expect(() =>
      CosignRequestSchema.parse({
        ...base,
        shards: makeShards(4)
      })
    ).toThrow();

    expect(() =>
      CosignRequestSchema.parse({
        ...base,
        shards: makeShards(21)
      })
    ).toThrow();
  });

  it("rejects frame text over 4000 chars and shard text over 500 chars", () => {
    expect(() =>
      OutboundFrameSchema.parse({
        type: "outbound",
        door_id: DOOR_ID,
        epoch: 77,
        msg_id: "msg_out_big",
        issued_at: ISSUED_AT,
        body: {
          text: "x".repeat(4001)
        },
        sig: encodeSignature(sign(new Uint8Array([1]), generateKeypair().privateKey))
      })
    ).toThrow();

    expect(() =>
      CandidateShardSchema.parse({
        shard_id: "shard_big",
        text: "x".repeat(501)
      })
    ).toThrow();
  });

  it("rejects core strings over 64 KiB", () => {
    expect(() =>
      AttestRequestSchema.parse({
        protocol_version: DOOR_PROTOCOL_VERSION,
        door_id: DOOR_ID,
        epoch: 77,
        kind: "heartbeat",
        core: "x".repeat(65537),
        session_pubkey: keys.sessionPubkey,
        issued_at: ISSUED_AT,
        sig: encodeSignature(sign(new Uint8Array([1]), generateKeypair().privateKey))
      })
    ).toThrow();
  });
});
