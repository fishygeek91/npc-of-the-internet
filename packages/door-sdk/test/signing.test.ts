import {
  canonicalize,
  corePayload,
  createRecord,
  encodePublicKey,
  generateKeypair,
  OSP_SPEC,
  signCore,
  verifyRecord
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import {
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  generateDoorKeypair,
  heartbeatSigningPayload,
  helloResponseSigningPayload,
  outboundSigningPayload,
  sessionBindSigningPayload,
  signCanonical,
  signDoorCosig,
  signingPayload,
  verifyCanonical,
  verifyDoorCosig
} from "../src/signing.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";

const ISSUED_AT = "2026-07-20T15:04:05.123Z";
const DOOR_ID = "discord:123456789012345678";
const PREV_CID = "bagu" + "a".repeat(57);

describe("door-sdk signing", () => {
  it("produces key-order-independent signingPayload bytes", () => {
    const first = signingPayload({ z: 1, a: 2, m: 3 });
    const second = signingPayload({ a: 2, m: 3, z: 1 });
    expect(first).toEqual(second);
    expect(new TextDecoder().decode(first)).toBe('{"a":2,"m":3,"z":1}');
  });

  it("round-trips signCanonical and verifyCanonical", () => {
    const keypair = generateDoorKeypair();
    const fields = { door_id: DOOR_ID, epoch: 77, seq: 1, accepted: true, received_at: ISSUED_AT };
    const sig = signCanonical(fields, keypair.privateKey);
    expect(verifyCanonical(fields, sig, keypair.publicKey)).toBe(true);
    expect(verifyCanonical({ ...fields, seq: 2 }, sig, keypair.publicKey)).toBe(false);
  });

  it("signs and verifies door_cosig over raw UTF-8 core bytes", () => {
    const door = generateDoorKeypair();
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC,
          seq: 3,
          prev: "bafytestprev",
          type: "memory",
          body: { text: "I remember the hallway." },
          residency: "door:discord:123456789012345678/epoch:77"
        })
      )
    );

    const doorCosig = signDoorCosig(core, door.privateKey);
    expect(verifyDoorCosig(core, doorCosig, door.publicKey)).toBe(true);
    expect(verifyDoorCosig(`${core}x`, doorCosig, door.publicKey)).toBe(false);
  });

  it("matches osp-core signCore for envelope core cosignatures", () => {
    const door = generateDoorKeypair();
    const fields = {
      seq: 4,
      prev: "bafyanother",
      type: "attestation" as const,
      body: { kind: "arrival" },
      residency: "door:discord:123456789012345678/epoch:77"
    };
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC,
          ...fields
        })
      )
    );
    const doorCosig = signDoorCosig(core, door.privateKey);
    const signCoreResult = signCore(fields, door.privateKey);
    expect(doorCosig).toBe(signCoreResult);
  });

  it("builds endpoint-specific signing payloads", () => {
    const session = generateKeypair();
    const sessionPubkey = encodePublicKey(session.publicKey);

    const attestPayload = attestSigningPayload({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: 77,
      kind: "departure",
      core: '{"spec":"osp/0.1"}',
      session_pubkey: sessionPubkey,
      issued_at: ISSUED_AT
    });
    expect(new TextDecoder().decode(attestPayload)).toContain('"kind":"departure"');
    expect(new TextDecoder().decode(attestPayload)).not.toContain("protocol_version");

    const heartbeatPayload = heartbeatSigningPayload({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: sessionPubkey,
      seq: 2,
      issued_at: ISSUED_AT
    });
    expect(new TextDecoder().decode(heartbeatPayload)).toContain('"protocol_version":"door/0.1"');

    const reviewPayload = cosignReviewSigningPayload({
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: sessionPubkey,
      farewell: "Goodbye",
      shards: Array.from({ length: 5 }, (_, index) => ({
        shard_id: `shard_${String(index + 1)}`,
        text: `Shard ${String(index + 1)}`
      })),
      issued_at: ISSUED_AT
    });
    expect(new TextDecoder().decode(reviewPayload)).toContain('"phase":"review"');

    const commitPayload = cosignCommitSigningPayload({
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "commit",
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: sessionPubkey,
      shard_id: "shard_1",
      core: '{"spec":"osp/0.1"}',
      issued_at: ISSUED_AT
    });
    expect(new TextDecoder().decode(commitPayload)).toContain('"phase":"commit"');

    const outboundPayload = outboundSigningPayload({
      type: "outbound",
      door_id: DOOR_ID,
      epoch: 77,
      msg_id: "msg_1",
      issued_at: ISSUED_AT,
      body: { text: "Reply" }
    });
    expect(new TextDecoder().decode(outboundPayload)).toContain('"type":"outbound"');

    const bindPayload = sessionBindSigningPayload({
      door_id: DOOR_ID,
      epoch: 77,
      session_pubkey: sessionPubkey
    });
    expect(new TextDecoder().decode(bindPayload)).toBe(
      `{"door_id":"${DOOR_ID}","epoch":77,"session_pubkey":"${sessionPubkey}"}`
    );

    const helloPayload = helloResponseSigningPayload({
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: DOOR_ID,
      door_pubkey: encodePublicKey(generateKeypair().publicKey),
      active_epoch: 77,
      capabilities: ["heartbeat"],
      community: {
        name: "Guild",
        description: "Test",
        platform: "discord",
        invitation_required: false
      },
      issued_at: ISSUED_AT
    });
    expect(new TextDecoder().decode(helloPayload)).toContain('"door_id"');
  });

  it("verifies door_cosig on a minimal memory envelope via verifyRecord", async () => {
    const soul = generateKeypair();
    const door = generateDoorKeypair();
    const fields = {
      seq: 5,
      prev: PREV_CID,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: "A committed shard.",
        distilled_at: ISSUED_AT
      },
      residency: "door:discord:123456789012345678/epoch:77"
    };
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC,
          ...fields
        })
      )
    );
    const doorCosig = signDoorCosig(core, door.privateKey);

    const { record } = await createRecord({
      ...fields,
      cosigners: [doorCosig],
      soulPrivateKey: soul.privateKey
    });

    const result = await verifyRecord(record, {
      soulPublicKey: soul.publicKey,
      doorPublicKeys: [door.publicKey]
    });

    expect(result.record.type).toBe("memory");
    expect(verifyDoorCosig(core, doorCosig, door.publicKey)).toBe(true);
  });
});
