import {
  canonicalize,
  computeCidFromCanonicalBytes,
  encodePublicKey,
  encodeShardTextBlob,
  encodeSignature,
  generateKeypair,
  hashBlobBytes,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import {
  attestSigningPayload,
  DOOR_PROTOCOL_VERSION,
  DoorError,
  type AttestRequest,
  type Door,
  type WitnessInput,
  type WitnessMemory
} from "@npc/door-sdk";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import type { DiscordDoorConfig } from "../src/config.js";
import { ARRIVED_NOTICE, MOVED_ON_NOTICE, startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { SOUL } from "./helpers/fixed-keys.js";
import {
  CHANNEL_ID,
  cleanupTempDirs,
  GUILD_ID,
  OPERATOR_ID,
  testConfig,
  USER_ID
} from "./helpers/harness.js";
import { TestClock } from "./helpers/test-clock.js";

const NOW = "2026-07-21T00:00:00.000Z";
const DOOR_ID = `discord:${GUILD_ID}`;

afterEach(async () => {
  await cleanupTempDirs();
});

function attestationCore(kind: "arrival" | "departure", epoch: number): string {
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.2",
      seq: 1,
      prev: "bafyprev",
      type: "attestation",
      body: { kind, door_id: DOOR_ID, epoch },
      residency: `door:${DOOR_ID}/epoch:${String(epoch)}`
    })
  );
}

async function shardCore(text: string, epoch: number): Promise<string> {
  const blob = encodeShardTextBlob(text);
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.2",
      seq: 2,
      prev: "bafyprev",
      type: "memory",
      body: {
        kind: "shard",
        text_cid: await computeCidFromCanonicalBytes(blob),
        text_hash: await hashBlobBytes(blob),
        distilled_at: NOW
      },
      residency: `door:${DOOR_ID}/epoch:${String(epoch)}`
    })
  );
}

function signed(fields: Omit<AttestRequest, "sig">, key: Ed25519Keypair): AttestRequest {
  return {
    ...fields,
    sig: encodeSignature(sign(attestSigningPayload(fields), key.privateKey))
  };
}

/** A Wanderer residency driven by hand: arrive, remember, depart. */
function residency(door: Door, epoch: number) {
  const session = generateKeypair();
  const base = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: DOOR_ID,
    epoch,
    session_pubkey: encodePublicKey(session.publicKey),
    issued_at: NOW
  };
  return {
    arrive: () =>
      door.attest(
        signed({ ...base, kind: "arrival", core: attestationCore("arrival", epoch) }, SOUL)
      ),
    remember: async (text: string) =>
      door.attest(
        signed({ ...base, kind: "memory", core: await shardCore(text, epoch), text }, session)
      ),
    depart: () =>
      door.attest(
        signed({ ...base, kind: "departure", core: attestationCore("departure", epoch) }, session)
      )
  };
}

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "debug" },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  );
  return { logger, lines, raw: () => JSON.stringify(lines) };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function start(options: {
  config?: Partial<DiscordDoorConfig>;
  witness?: WitnessMemory;
  gateway?: FakeGateway;
}) {
  const gateway = options.gateway ?? new FakeGateway();
  const log = captureLogger();
  const handle = await startDiscordDoor({
    config: await testConfig(options.config),
    gateway,
    clock: new TestClock(NOW),
    logger: log.logger,
    disableServers: true,
    sessionBridge: { handleInbound: async () => null },
    ...(options.witness === undefined ? {} : { witness: options.witness })
  });
  return { handle, gateway, log };
}

async function statusReply(gateway: FakeGateway): Promise<string> {
  await gateway.emitCommand({
    kind: "status",
    interactionId: `ix-${String(gateway.ephemerals.length)}`,
    userId: OPERATOR_ID,
    ephemeral: true
  });
  return gateway.ephemerals.at(-1)?.content ?? "";
}

describe("memory witness wiring", () => {
  it("witnesses a memory against the Door's own record of the stay", async () => {
    const seen: WitnessInput[] = [];
    const { handle, gateway, log } = await start({
      witness: async (input) => {
        seen.push(input);
        return { witnessed: true };
      }
    });
    const hello = await handle.door.hello({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(SOUL.publicKey)
    });
    expect(hello.capabilities).toContain("attest.memory");
    expect(hello.capabilities.some((c) => c.startsWith("cosign"))).toBe(false);
    expect(log.lines.find((l) => l.msg === "door_witness_config")).toMatchObject({
      enabled: true,
      model: null
    });

    const stay = residency(handle.door, 1);
    await stay.arrive();
    await gateway.emitMessage({
      id: "d-1",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "Traveler",
      content: "the river froze early this year",
      isBot: false,
      replyToId: undefined
    });

    const response = await stay.remember("Someone told me the river froze early.");
    expect(response.kind).toBe("memory");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      doorId: DOOR_ID,
      epoch: 1,
      kind: "shard",
      text: "Someone told me the river froze early."
    });
    expect(seen[0]?.transcript).toEqual([
      expect.objectContaining({
        role: "community",
        author: "Traveler",
        text: "the river froze early this year"
      })
    ]);

    expect(await statusReply(gateway)).toContain("memories: witnessed");
    await handle.stop();
  });

  it("a declining witness rejects the memory (witness_declined)", async () => {
    const { handle } = await start({
      witness: async () => ({ witnessed: false, reason: "ungrounded" })
    });
    const stay = residency(handle.door, 1);
    await stay.arrive();
    const error = await stay.remember("I met a dragon here.").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DoorError);
    expect((error as DoorError).code).toBe("witness_declined");
    await handle.stop();
  });

  it("builds the AI witness from config.witness and never logs the key", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"verdict":"witness"}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const { handle, log } = await start({
      config: {
        witness: {
          baseUrl: "https://witness.test/v1",
          apiKey: "sk-secret-witness-key",
          model: "witness-model",
          fetchImpl
        }
      }
    });
    expect(handle.door.witnessesMemories()).toBe(true);
    expect(log.lines.find((l) => l.msg === "door_witness_config")).toMatchObject({
      enabled: true,
      model: "witness-model"
    });
    expect(log.raw()).not.toContain("sk-secret-witness-key");

    const stay = residency(handle.door, 1);
    await stay.arrive();
    await stay.remember("A quiet stay.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://witness.test/v1/chat/completions");
    expect(requests[0]?.body).toContain("A quiet stay.");
    await handle.stop();
  });

  it("without a witness: no attest.memory, memories unsupported, status says so", async () => {
    const { handle, gateway, log } = await start({});
    expect(handle.door.capabilities()).not.toContain("attest.memory");
    expect(log.lines.find((l) => l.msg === "door_witness_config")).toMatchObject({
      enabled: false
    });
    const stay = residency(handle.door, 1);
    await stay.arrive();
    const error = await stay.remember("Anything.").catch((e: unknown) => e);
    expect((error as DoorError).code).toBe("unsupported_kind");
    expect(await statusReply(gateway)).toContain("memories: not witnessed");
    await handle.stop();
  });
});

describe("presence notices", () => {
  function notices(gateway: FakeGateway): string[] {
    return gateway.sent.filter((m) => m.channelId === CHANNEL_ID).map((m) => m.content);
  }

  it("announces arrival and departure in the residency channel", async () => {
    const { handle, gateway } = await start({ config: { presenceNotices: true } });
    const stay = residency(handle.door, 1);
    await stay.arrive();
    await settle();
    expect(notices(gateway)).toEqual([ARRIVED_NOTICE]);
    await stay.depart();
    await settle();
    expect(notices(gateway)).toEqual([ARRIVED_NOTICE, MOVED_ON_NOTICE]);
    await handle.stop();
  });

  it("a restart (superseded epoch) posts nothing", async () => {
    const { handle, gateway } = await start({ config: { presenceNotices: true } });
    await residency(handle.door, 1).arrive();
    await residency(handle.door, 2).arrive();
    await settle();
    expect(notices(gateway)).toEqual([ARRIVED_NOTICE]);
    await handle.stop();
  });

  it("DISCORD_PRESENCE_NOTICES=0 (presenceNotices false) posts nothing", async () => {
    const { handle, gateway } = await start({ config: { presenceNotices: false } });
    const stay = residency(handle.door, 1);
    await stay.arrive();
    await stay.depart();
    await settle();
    expect(gateway.sent).toHaveLength(0);
    await handle.stop();
  });

  it("a failed post is logged, never thrown into the protocol path", async () => {
    const gateway = new FakeGateway();
    gateway.sendMessage = async () => {
      throw new Error("discord down");
    };
    const { handle, log } = await start({ gateway, config: { presenceNotices: true } });
    const stay = residency(handle.door, 1);
    await expect(stay.arrive()).resolves.toMatchObject({ kind: "arrival" });
    await settle();
    expect(log.lines.find((l) => l.msg === "presence_notice_failed")).toMatchObject({
      event: "arrived",
      epoch: 1
    });
    await handle.stop();
  });
});
