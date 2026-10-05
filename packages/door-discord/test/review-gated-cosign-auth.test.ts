import {
  canonicalize,
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
/** Canonical OSP attestation core bound to `(door_id, epoch, kind)` — the Door rejects unbound cores. */
function attestCore(kind: AttestRequest["kind"], epoch: number, doorId: string): string {
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
    core: attestCore("arrival", EPOCH, doorId),
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

  it("authenticated oversized shard array posts zero gateway messages", async () => {
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

    await handle.connection.attest(signAttestArrival(SOUL, session, doorId));

    const oversizedShards = Array.from({ length: 21 }, (_, index) => ({
      shard_id: `flood_${String(index + 1)}`,
      text: `Flood shard ${String(index + 1)}`
    }));
    const beforeSent = gateway.sent.length;
    const beforeReactions = gateway.reactions.length;
    const reviewRequest = signCosignReview(session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: doorId,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      shards: oversizedShards,
      issued_at: ISSUED_AT
    });

    await expect(handle.door.cosign(reviewRequest)).rejects.toBeInstanceOf(DoorError);
    await expect(handle.door.cosign(reviewRequest)).rejects.toMatchObject({
      code: "shard_count"
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

describe("ReviewGatedDoor replay / concurrency (review 2026-10)", () => {
  async function startWithArrival(): Promise<{
    gateway: FakeGateway;
    handle: Awaited<ReturnType<typeof startDiscordDoor>>;
    doorId: string;
    session: Ed25519Keypair;
  }> {
    const gateway = new FakeGateway();
    const config = await testConfig({ reviewTimeoutMs: 60_000 });
    const doorId = doorIdForGuild(config.guildId);
    const session = generateKeypair();
    const handle = await startDiscordDoor({
      config,
      gateway,
      clock: new TestClock(CLOCK_START),
      sleep: async (ms) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(ms, 5));
        });
      },
      disableServers: true
    });
    await handle.connection.attest(signAttestArrival(SOUL, session, doorId));
    return { gateway, handle, doorId, session };
  }

  function reviewRequest(
    session: Ed25519Keypair,
    doorId: string,
    issuedAt = ISSUED_AT
  ): Extract<CosignRequest, { phase: "review" }> {
    return signCosignReview(session, {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: doorId,
      epoch: EPOCH,
      session_pubkey: encodePublicKey(session.publicKey),
      shards: Array.from({ length: 5 }, (_, index) => ({
        shard_id: `ok_${String(index + 1)}`,
        text: `A calm memory ${String(index + 1)}.`
      })),
      issued_at: issuedAt
    });
  }

  async function waitForReviews(gateway: FakeGateway, count: number): Promise<void> {
    for (let attempt = 0; attempt < 200 && reviewMessageCount(gateway) < count; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }

  async function approveAll(gateway: FakeGateway): Promise<void> {
    for (const message of gateway.sent) {
      if (message.content.includes("**Cosign review**")) {
        await gateway.emitReaction({
          messageId: message.id,
          channelId: CHANNEL_ID,
          userId: OPERATOR_ID,
          emoji: APPROVE_EMOJI
        });
      }
    }
  }

  it("stale issued_at is rejected before any review post", async () => {
    const { gateway, handle, doorId, session } = await startWithArrival();
    const stale = reviewRequest(session, doorId, "2026-07-20T00:00:00.000Z");
    await expect(handle.door.cosign(stale)).rejects.toMatchObject({ code: "timestamp_stale" });
    expect(reviewMessageCount(gateway)).toBe(0);
    await handle.stop();
  });

  it("an identical retry joins the in-flight review; shards are posted once", async () => {
    const { gateway, handle, doorId, session } = await startWithArrival();
    const request = reviewRequest(session, doorId);
    const first = handle.door.cosign(request);
    await waitForReviews(gateway, 5);
    const second = handle.door.cosign(request);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(reviewMessageCount(gateway)).toBe(5);

    await approveAll(gateway);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.phase).toBe("review");
    await handle.stop();
  });

  it("a different concurrent review is rejected (review_pending) without re-posting", async () => {
    const { gateway, handle, doorId, session } = await startWithArrival();
    const first = handle.door.cosign(reviewRequest(session, doorId));
    await waitForReviews(gateway, 5);
    await expect(
      handle.door.cosign(reviewRequest(session, doorId, "2026-07-21T00:02:00.000Z"))
    ).rejects.toMatchObject({ code: "review_pending" });
    expect(reviewMessageCount(gateway)).toBe(5);

    await approveAll(gateway);
    await expect(first).resolves.toMatchObject({ phase: "review" });
    await handle.stop();
  });
});
