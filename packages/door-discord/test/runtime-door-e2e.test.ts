/**
 * End-to-end tests: the REAL runtime `Session` against the REAL `startDiscordDoor`
 * (door-sdk `Door` + memory witness), with a fake Discord gateway and a fake witness.
 * Covers witnessed depart (no human in the loop), a witness outage retried later, and a
 * runtime restart superseding the live epoch.
 */
import { verifyChain } from "@npc/osp-core";
import type { WitnessMemory } from "@npc/door-sdk";
import { FakeBrain, MemoryTranscriptSource, Session, SingleKeyKeyring } from "@npc/runtime";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { FakeTimer } from "./helpers/fake-timer.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import {
  CHANNEL_ID,
  cleanupTempDirs,
  genesisStore,
  GUILD_ID,
  testConfig,
  USER_ID
} from "./helpers/harness.js";
import { MutableClock } from "./helpers/mutable-clock.js";

afterEach(async () => {
  await cleanupTempDirs();
});

const START_MS = Date.parse("2026-07-21T00:00:00.000Z");

const shardsJson = (n: number): string =>
  JSON.stringify({
    shards: Array.from({ length: n }, (_, i) => ({ text: `I remember thing ${String(i + 1)}.` }))
  });

const transcript = (): MemoryTranscriptSource =>
  new MemoryTranscriptSource(
    Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `line ${String(i)} about stars`
    }))
  );

async function boot(witness: WitnessMemory) {
  const gateway = new FakeGateway();
  const clock = new MutableClock(START_MS);
  const timer = new FakeTimer();
  const doorId = doorIdForGuild(GUILD_ID);
  const store = await genesisStore();
  let session: Session | null = null;
  const handle = await startDiscordDoor({
    config: await testConfig(),
    gateway,
    clock,
    witness,
    disableServers: true,
    sessionBridge: {
      handleInbound: async (frame) => {
        if (session === null) return null;
        const res = await session.handleInbound(frame);
        return res.ok ? res.outbound : null;
      }
    }
  });
  session = await Session.start({
    store,
    door: handle.connection,
    doorId,
    keyring: new SingleKeyKeyring(SOUL.privateKey),
    brain: new FakeBrain(["hi there"]),
    clock,
    timer,
    heartbeatIntervalMs: 600_000,
    doorPublicKeys: { [doorId]: DOOR.publicKey },
    witnessesMemories: handle.door.witnessesMemories()
  });
  const journalDir = await mkdtemp(join(tmpdir(), "e2e-j-"));
  const departOptions = () => ({
    brain: new FakeBrain([shardsJson(5), "# journal\n\ntext"]),
    transcript: transcript(),
    journalDir
  });
  return { gateway, clock, timer, store, doorId, handle, session, departOptions };
}

describe("E2E runtime <-> door-discord", () => {
  it("arrival, 2 heartbeats, inbound/outbound, witnessed depart — chain verifies", async () => {
    const texts: string[] = [];
    const { gateway, clock, timer, store, doorId, handle, session, departOptions } = await boot(
      async (input) => {
        texts.push(input.text);
        return { witnessed: true };
      }
    );
    await gateway.emitMessage({
      id: "11111",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "T",
      content: "hello",
      isBot: false,
      replyToId: undefined
    });
    expect(gateway.sent.some((m) => m.content === "hi there")).toBe(true);
    for (let i = 0; i < 2; i += 1) {
      clock.advance(600_000);
      timer.tick();
      await session.drainAppends();
      expect(session.lastHeartbeatError).toBeNull();
    }
    const dep = await session.depart(departOptions());
    expect(dep).toMatchObject({ witnessed: 5, declined: 0 });
    expect(texts).toHaveLength(6); // five shards + the journal

    const cosigned: string[][] = [];
    for await (const record of store.iterate()) {
      if (record.type === "memory") {
        cosigned.push(record.cosigners);
      }
    }
    expect(cosigned).toHaveLength(6);
    expect(cosigned.every((cosigners) => cosigners.length === 1)).toBe(true);
    const v = await verifyChain(store, { doorPublicKeys: { [doorId]: DOOR.publicKey } });
    expect(v.valid).toBe(true);
    expect(handle.status().present).toBe(false);
    await handle.stop();
  });

  it("a witness outage fails depart (witness_unavailable); a later retry completes", async () => {
    let calls = 0;
    const { clock, store, doorId, handle, session, departOptions } = await boot(async () => {
      calls += 1;
      if (calls === 3) {
        throw new Error("model timeout");
      }
      return { witnessed: true };
    });
    await expect(session.depart(departOptions())).rejects.toMatchObject({
      code: "witness_unavailable"
    });
    expect(handle.status().present).toBe(true);
    clock.advance(1000);
    const dep = await session.depart(departOptions());
    expect(dep).toMatchObject({ witnessed: 5, declined: 0 });
    const v = await verifyChain(store, { doorPublicKeys: { [doorId]: DOOR.publicKey } });
    expect(v.valid).toBe(true);
    await handle.stop();
  });

  it("runtime restart without depart: new epoch arrival supersedes; out-1 accepted again; relay maps per epoch", async () => {
    const { gateway, clock, timer, store, doorId, handle, session } = await boot(async () => ({
      witnessed: true
    }));
    const emit = (id: string, content: string, replyToId?: string) =>
      gateway.emitMessage({
        id,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        authorId: USER_ID,
        authorDisplay: "T",
        content,
        isBot: false,
        replyToId
      });
    await emit("20001", "hello one");
    const firstReply = gateway.sent.find((m) => m.content === "hi there");
    expect(firstReply).toBeDefined();
    session.stop(); // crash
    clock.advance(1000);
    const s2 = await Session.start({
      store,
      door: handle.connection,
      doorId,
      keyring: new SingleKeyKeyring(SOUL.privateKey),
      brain: new FakeBrain(["second epoch reply"]),
      clock,
      timer,
      heartbeatIntervalMs: 600_000,
      activeEpoch: handle.status().epoch ?? null,
      doorPublicKeys: { [doorId]: DOOR.publicKey }
    });
    expect(s2.epoch).toBe(session.epoch + 1);
    const res = await s2.handleInbound(
      handle.door.createInboundFrame({
        msg_id: "x-1",
        body: { text: "hello two", author_id: "u", channel_id: CHANNEL_ID }
      })
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outbound.msg_id).toBe("out-1");
      expect(() => handle.door.handleOutbound(res.outbound)).not.toThrow();
      expect(() => handle.door.handleOutbound(res.outbound)).toThrow(/msg_replay/u);
    }
    timer.tick();
    await s2.drainAppends();
    expect(s2.lastHeartbeatError).toBeNull();
    const v = await verifyChain(store, { doorPublicKeys: { [doorId]: DOOR.publicKey } });
    expect(v.valid).toBe(true);
    await handle.stop();
  });
});
