import { encodePublicKey, encodeSignature, generateKeypair, sign } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import {
  AttestRequestSchema,
  CapabilitySchema,
  ControlFrameSchema,
  DOOR_PROTOCOL_VERSION,
  ErrorFrameSchema,
  HeartbeatRequestSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  InboundFrameSchema,
  MEMORY_ATTEST_TEXT_MAX,
  OutboundFrameSchema,
  WitnessReasonSchema
} from "../src/schemas.js";

const ISSUED_AT = "2026-07-20T15:09:00.000Z";
const DOOR_ID = "discord:test-guild";

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

describe("door-sdk schemas", () => {
  const keys = makeKeyMaterial();

  it("accepts hello request/response fixtures", () => {
    const helloRequest = HelloRequestSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: keys.soulPubkey,
      client: "npc-runtime/0.1.0"
    });
    expect(helloRequest.protocol_version).toBe("door/0.2");
    expect(() =>
      HelloRequestSchema.parse({ protocol_version: "door/0.1", soul_pubkey: keys.soulPubkey })
    ).toThrow();

    const helloResponse = HelloResponseSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      door_pubkey: keys.doorPubkey,
      active_epoch: null,
      // Unknown / legacy capability strings are accepted (forward compat) and ignored.
      capabilities: ["session.text", "attest.memory", "cosign.manual", "future.feature"],
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
    expect(helloResponse.capabilities).toContain("future.feature");
    expect(() => HelloResponseSchema.parse({ ...helloResponse, capabilities: [""] })).toThrow();
  });

  it("registers attest.memory and no cosign capabilities", () => {
    expect(CapabilitySchema.options).toContain("attest.memory");
    expect(CapabilitySchema.options.filter((value) => value.startsWith("cosign"))).toEqual([]);
  });

  it("accepts attest and heartbeat fixtures", () => {
    const attest = AttestRequestSchema.parse({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: 77,
      kind: "arrival",
      core: '{"spec":"osp/0.1","seq":2,"prev":"bafy","type":"attestation","body":{},"residency":"door:discord:test-guild/epoch:77"}',
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
  });

  describe("memory attest text", () => {
    const base = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: 77,
      core: '{"spec":"osp/0.2"}',
      session_pubkey: keys.sessionPubkey,
      issued_at: ISSUED_AT,
      sig: encodeSignature(sign(new Uint8Array([4]), generateKeypair().privateKey))
    };

    it("requires text on kind memory and accepts it up to MEMORY_ATTEST_TEXT_MAX code points", () => {
      expect(MEMORY_ATTEST_TEXT_MAX).toBe(32_000);
      const memory = AttestRequestSchema.parse({ ...base, kind: "memory", text: "I remember." });
      expect(memory.text).toBe("I remember.");
      // Code points, not UTF-16 units: 32 000 astral characters are 64 000 units.
      const astral = "\u{1F332}".repeat(MEMORY_ATTEST_TEXT_MAX);
      expect(AttestRequestSchema.safeParse({ ...base, kind: "memory", text: astral }).success).toBe(
        true
      );
      expect(
        AttestRequestSchema.safeParse({ ...base, kind: "memory", text: `${astral}x` }).success
      ).toBe(false);
    });

    it("rejects memory without text, empty text, and text on other kinds", () => {
      const missing = AttestRequestSchema.safeParse({ ...base, kind: "memory" });
      expect(missing.success).toBe(false);
      expect(missing.error?.issues.map((issue) => issue.path.join("."))).toContain("text");
      expect(AttestRequestSchema.safeParse({ ...base, kind: "memory", text: "" }).success).toBe(
        false
      );
      for (const kind of ["arrival", "heartbeat", "departure"] as const) {
        const parsed = AttestRequestSchema.safeParse({ ...base, kind, text: "smuggled" });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("text");
        expect(AttestRequestSchema.safeParse({ ...base, kind }).success).toBe(true);
      }
    });
  });

  it("witness reasons are exactly the spec set", () => {
    expect(WitnessReasonSchema.options).toEqual([
      "ungrounded",
      "private",
      "harmful",
      "manipulation",
      "other"
    ]);
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

  it("rejects frame text over 4000 chars", () => {
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

describe("session.reactions / session.addressing (additive door/0.1 fields)", () => {
  const sig = encodeSignature(sign(new Uint8Array([7]), generateKeypair().privateKey));
  const outbound = (body: Record<string, unknown>) => ({
    type: "outbound",
    door_id: DOOR_ID,
    epoch: 77,
    msg_id: "msg_out_r",
    issued_at: ISSUED_AT,
    body,
    sig
  });

  it("accepts reaction-only, text+reaction, and text-only outbound bodies", () => {
    expect(
      OutboundFrameSchema.safeParse(outbound({ reaction: { emoji: "😂", target_msg_id: "m1" } }))
        .success
    ).toBe(true);
    expect(
      OutboundFrameSchema.safeParse(
        outbound({ text: "ha", reply_to: "m1", reaction: { emoji: "👍🏽", target_msg_id: "m1" } })
      ).success
    ).toBe(true);
    expect(OutboundFrameSchema.safeParse(outbound({ text: "plain" })).success).toBe(true);
  });

  it("rejects empty bodies and non-single-emoji reactions", () => {
    expect(OutboundFrameSchema.safeParse(outbound({})).success).toBe(false);
    expect(OutboundFrameSchema.safeParse(outbound({ reply_to: "m1" })).success).toBe(false);
    for (const emoji of ["", "ok", "😂😂", ":smile:", "<:custom:123>", "😂 "]) {
      expect(
        OutboundFrameSchema.safeParse(outbound({ reaction: { emoji, target_msg_id: "m1" } }))
          .success,
        emoji
      ).toBe(false);
    }
    expect(
      OutboundFrameSchema.safeParse(outbound({ reaction: { emoji: "😂", target_msg_id: "" } }))
        .success
    ).toBe(false);
  });

  it("accepts the ZWJ family, flags, and keycaps as single emoji", () => {
    for (const emoji of ["👨‍👩‍👧", "🇺🇸", "1️⃣", "❤️"]) {
      expect(
        OutboundFrameSchema.safeParse(outbound({ reaction: { emoji, target_msg_id: "m1" } }))
          .success,
        emoji
      ).toBe(true);
    }
  });

  it("inbound frames carry an optional boolean addressed flag", () => {
    const base = {
      type: "inbound",
      door_id: DOOR_ID,
      epoch: 77,
      msg_id: "msg_in_a",
      issued_at: ISSUED_AT
    };
    const parsed = InboundFrameSchema.parse({
      ...base,
      body: { text: "hey", author_id: "u", addressed: true }
    });
    expect(parsed.body.addressed).toBe(true);
    expect(
      InboundFrameSchema.safeParse({
        ...base,
        body: { text: "hey", author_id: "u", addressed: "yes" }
      }).success
    ).toBe(false);
  });
});
