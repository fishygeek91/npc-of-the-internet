import {
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import {
  DOOR_PROTOCOL_VERSION,
  DoorError,
  attestSigningPayload,
  cosignReviewSigningPayload,
  type AttestRequest,
  type CosignRequest
} from "@npc/door-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { APPROVE_EMOJI } from "../src/review-gate.js";
import { startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { SOUL } from "./helpers/fixed-keys.js";
import { CHANNEL_ID, OPERATOR_ID, cleanupTempDirs, testConfig } from "./helpers/harness.js";
import { TestClock } from "./helpers/test-clock.js";

const CLOCK_START = "2026-07-21T00:00:00.000Z";
const EPOCH = 42;
const ISSUED_AT = "2026-07-21T00:01:00.000Z";
const ATTEST_CORE = '{"type":"attestation","kind":"arrival"}';

afterEach(async () => {
  await cleanupTempDirs();
});

/**
 * Build five candidate shards with attacker-controlled text for auth-failure cases.
 */
function attackerShards(): Array<{ shard_id: string; text: string }> {
  return Array.from({ length: 5 }, (_, index) => ({
    shard_id: `atk_${String(index + 1)}`,
    text: `@everyone attacker payload ${String(index + 1)}`
  }));
}

function signAttestArrival(
  soul: Ed25519Keypair,
  session: Ed25519Keypair,
  doorId: string
): AttestRequest {
  const fields: Omit<AttestRequest, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: doorId,
    epoch: EPOCH,
    kind: "arrival",
    core: ATTEST_CORE,
    session_pubkey: encodePublicKey(session.publicKey),
    issued_at: ISSUED_AT
  };
  const payload = attestSigningPayload(fields);
  return { ...fields, sig: encodeSignature(sign(payload, soul.privateKey)) };
}

function signCosignReview(
  session: Ed25519Keypair,
  fields: Omit<Extract<CosignRequest, { phase: "review" }>, "sig">
): Extract<CosignRequest, { phase: "review" }> {
  const payload = cosignReviewSigningPayload(fields);
  return { ...fields, sig: encodeSignature(sign(payload, session.privateKey)) };
}

function reviewMessageCount(gateway: FakeGateway): number {
  return gateway.sent.filter((message) => message.content.includes("**Cosign review**")).length;
}

describe("ReviewGatedDoor cosign auth before Discord side effects", () => {
  it("cosign review with no active session posts zero gateway messages", async () => {
    const gateway = new FakeGateway();
    const clock = new TestClock(CLOCK_START);
    const config = await testConfig({ reviewTimeoutMs: 2_000 });
    const doorId = doorIdForGuild(config.guildId);
    const session = generateKeypair();

    const handle = await startDiscordDoor({
      config,
      gateway,
      clock,
      sleep: async (ms) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(ms, 5));
        });
      },
      disableServers: true
    });

    const beforeSent = gateway.sent.length;
    const beforeReactions = gateway.reactions.length;
    const reviewRequest = signCosignReview(session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: doorId,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      shards: attackerShards(),
      issued_at: ISSUED_AT
    });

    await expect(handle.door.cosign(reviewRequest)).rejects.toBeInstanceOf(DoorError);
    await expect(handle.door.cosign(reviewRequest)).rejects.toMatchObject({
      code: "session_invalid"
    });

    expect(gateway.sent.length).toBe(beforeSent);
    expect(gateway.reactions.length).toBe(beforeReactions);
    expect(reviewMessageCount(gateway)).toBe(0);

    await handle.stop();
  });

  it("cosign review with invalid signature posts zero gateway messages", async () => {
    const gateway = new FakeGateway();
    const clock = new TestClock(CLOCK_START);
    const config = await testConfig({ reviewTimeoutMs: 2_000 });
    const doorId = doorIdForGuild(config.guildId);
    const session = generateKeypair();
    const wrongSession = generateKeypair();

    const handle = await startDiscordDoor({
      config,
      gateway,
      clock,
      sleep: async (ms) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(ms, 5));
        });
      },
      disableServers: true
    });

    await handle.connection.attest(signAttestArrival(SOUL, session, doorId));

    const beforeSent = gateway.sent.length;
    const beforeReactions = gateway.reactions.length;
    const reviewRequest = signCosignReview(wrongSession, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: doorId,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      shards: attackerShards(),
      issued_at: ISSUED_AT
    });

    await expect(handle.door.cosign(reviewRequest)).rejects.toBeInstanceOf(DoorError);
    await expect(handle.door.cosign(reviewRequest)).rejects.toMatchObject({
      code: "signature_invalid"
    });

    expect(gateway.sent.length).toBe(beforeSent);
    expect(gateway.reactions.length).toBe(beforeReactions);
    expect(reviewMessageCount(gateway)).toBe(0);

    await handle.stop();
  });

  it("valid cosign review still posts review messages to the gateway", async () => {
    const gateway = new FakeGateway();
    const clock = new TestClock(CLOCK_START);
    const config = await testConfig({ reviewTimeoutMs: 5_000 });
    const doorId = doorIdForGuild(config.guildId);
    const session = generateKeypair();

    const handle = await startDiscordDoor({
      config,
      gateway,
      clock,
      sleep: async (ms) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(ms, 5));
        });
      },
      disableServers: true
    });

    gateway.onReaction((reaction) => {
      handle.reviewGate.handleReaction(reaction);
    });

    await handle.connection.attest(signAttestArrival(SOUL, session, doorId));

    const shards = Array.from({ length: 5 }, (_, index) => ({
      shard_id: `ok_${String(index + 1)}`,
      text: `Memory shard ${String(index + 1)} from a valid residency.`
    }));

    const reviewPromise = handle.door.cosign(
      signCosignReview(session, {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "review",
        door_id: doorId,
        epoch: EPOCH,
        session_pubkey: encodePublicKey(session.publicKey),
        shards,
        issued_at: ISSUED_AT
      })
    );

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (reviewMessageCount(gateway) >= 5) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    expect(reviewMessageCount(gateway)).toBe(5);

    for (const message of gateway.sent) {
      if (!message.content.includes("**Cosign review**")) {
        continue;
      }
      await gateway.emitReaction({
        messageId: message.id,
        channelId: CHANNEL_ID,
        userId: OPERATOR_ID,
        emoji: APPROVE_EMOJI
      });
    }

    const response = await reviewPromise;
    expect(response.phase).toBe("review");
    expect(response.decisions.every((decision) => decision.status === "approved")).toBe(true);

    await handle.stop();
  });
});
