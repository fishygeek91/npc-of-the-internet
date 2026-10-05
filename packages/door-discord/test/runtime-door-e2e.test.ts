/**
 * End-to-end regression tests: the REAL runtime `Session` / `commitQuarantinedShards`
 * against the REAL `startDiscordDoor` / `ReviewGatedDoor`, with a fake Discord gateway.
 * Covers the round-2 review findings: slow human review (> skew window), retries after a
 * lost review reply (in flight and completed), and a lost commit reply.
 */
import { verifyChain } from "@npc/osp-core";
import type { CosignRequest, CosignResponse } from "@npc/door-sdk";
import {
  FakeBrain,
  MemoryTranscriptSource,
  Session,
  SingleKeyKeyring,
  commitQuarantinedShards,
  type DoorConnection
} from "@npc/runtime";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { APPROVE_EMOJI } from "../src/review-gate.js";
import { startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { FakeTimer } from "./helpers/fake-timer.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import {
  autoApproveReviews,
  CHANNEL_ID,
  cleanupTempDirs,
  genesisStore,
  GUILD_ID,
  OPERATOR_ID,
  testConfig,
  USER_ID
} from "./helpers/harness.js";
import { MutableClock } from "./helpers/mutable-clock.js";

afterEach(async () => {
  await cleanupTempDirs();
});

const START_MS = Date.parse("2026-07-21T00:00:00.000Z");
const REVIEW_MARKER = "**Cosign review**";

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

/** Settles when `p` settles, never rejects (safe for `autoApproveReviews`). */
const settled = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    () => undefined
  );

const reviewPosts = (gateway: FakeGateway): number =>
  gateway.sent.filter((m) => m.content.includes(REVIEW_MARKER)).length;

/** Wrap a Door connection, replacing only `cosign`. */
function withCosign(
  connection: DoorConnection,
  cosign: (request: CosignRequest) => Promise<CosignResponse>
): DoorConnection {
  return {
    attest: (request) => connection.attest(request),
    heartbeat: (request) => connection.heartbeat(request),
    cosign
  };
}

async function boot(opts: {
  reviewTimeoutMs: number;
  /** Advance the shared clock by each review-gate poll interval (simulated wall time). */
  sleepAdvances?: boolean;
  onSleep?: (clock: MutableClock, gateway: FakeGateway) => Promise<void>;
  wrapDoor?: (connection: DoorConnection) => DoorConnection;
}) {
  const gateway = new FakeGateway();
  const clock = new MutableClock(START_MS);
  const timer = new FakeTimer();
  const config = await testConfig({ reviewTimeoutMs: opts.reviewTimeoutMs });
  const doorId = doorIdForGuild(GUILD_ID);
  const store = await genesisStore();
  let session: Session | null = null;
  const handle = await startDiscordDoor({
    config,
    gateway,
    clock,
    sleep: async (ms) => {
      if (opts.sleepAdvances === true) {
        clock.advance(ms + 1); // +1 ms per poll ~ real Discord / event-loop latency
      }
      await opts.onSleep?.(clock, gateway);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    disableServers: true,
    sessionBridge: {
      handleInbound: async (frame) => {
        if (session === null) return null;
        const res = await session.handleInbound(frame);
        return res.ok ? res.outbound : null;
      }
    }
  });
  const door = opts.wrapDoor?.(handle.connection) ?? handle.connection;
  session = await Session.start({
    store,
    door,
    doorId,
    keyring: new SingleKeyKeyring(SOUL.privateKey),
    brain: new FakeBrain(["hi there"]),
    clock,
    timer,
    heartbeatIntervalMs: 600_000,
    doorPublicKeys: { [doorId]: DOOR.publicKey }
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
  it("arrival, 2 heartbeats, inbound/outbound, depart review, commit — chain verifies", async () => {
    const { gateway, clock, timer, store, doorId, handle, session, departOptions } = await boot({
      reviewTimeoutMs: 10_000
    });
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
    const p = session.depart(departOptions());
    await autoApproveReviews(gateway, settled(p));
    const dep = await p;
    expect(dep.approvedShardIds.length).toBe(5);
    clock.advance(10_000);
    const res = await commitQuarantinedShards({
      store,
      keyring: new SingleKeyKeyring(SOUL.privateKey),
      door: handle.connection,
      doorId,
      clock,
      quarantineWindowMs: 1
    });
    expect(res.committedCids.length).toBe(5);
    const v = await verifyChain(store, { doorPublicKeys: { [doorId]: DOOR.publicKey } });
    expect(v.valid).toBe(true);
    await handle.stop();
  });

  it("a host review that takes longer than the 5 min skew window still completes", async () => {
    let approved = false;
    const { gateway, clock, store, doorId, handle, session, departOptions } = await boot({
      reviewTimeoutMs: 600_000,
      sleepAdvances: true,
      // The operator approves 6+ minutes after the request was issued.
      onSleep: async (c, g) => {
        if (approved || c.nowMs() - START_MS < 360_000) return;
        approved = true;
        for (const message of g.sent.filter((m) => m.content.includes(REVIEW_MARKER))) {
          await g.emitReaction({
            messageId: message.id,
            channelId: message.channelId,
            userId: OPERATOR_ID,
            emoji: APPROVE_EMOJI
          });
        }
      }
    });
    const dep = await session.depart(departOptions());
    expect(approved).toBe(true);
    expect(clock.nowMs() - START_MS).toBeGreaterThan(300_000);
    expect(reviewPosts(gateway)).toBe(5);
    expect(dep.approvedShardIds.length).toBe(5);

    clock.advance(10_000);
    const res = await commitQuarantinedShards({
      store,
      keyring: new SingleKeyKeyring(SOUL.privateKey),
      door: handle.connection,
      doorId,
      clock,
      quarantineWindowMs: 1
    });
    expect(res.committedCids.length).toBe(5);
    await handle.stop();
  }, 60_000);

  it("an ignored review at the default timeout rejects every shard without timestamp_stale", async () => {
    const { gateway, handle, session, departOptions } = await boot({
      reviewTimeoutMs: 240_000, // production default DISCORD_REVIEW_TIMEOUT_MS (config.test)
      sleepAdvances: true
    });
    const dep = await session.depart(departOptions());
    expect(reviewPosts(gateway)).toBe(5);
    expect(dep.approvedShardIds).toEqual([]);
    await handle.stop();
  }, 60_000);

  it("commit retry after a lost Door reply gets the same cosig (idempotent same seq)", async () => {
    const { gateway, clock, store, doorId, handle, session, departOptions } = await boot({
      reviewTimeoutMs: 10_000
    });
    const p = session.depart(departOptions());
    await autoApproveReviews(gateway, settled(p));
    await p;
    let lostCosig: string | null = null;
    const lossy = withCosign(handle.connection, async (request) => {
      const out = await handle.connection.cosign(request);
      if (lostCosig === null && out.phase === "commit") {
        lostCosig = out.door_cosig;
        throw new Error("ECONNRESET (response lost)");
      }
      return out;
    });
    const opts = {
      store,
      keyring: new SingleKeyKeyring(SOUL.privateKey),
      door: lossy,
      doorId,
      clock,
      quarantineWindowMs: 1
    };
    clock.advance(10_000);
    await expect(commitQuarantinedShards(opts)).rejects.toThrow(/ECONNRESET/u);
    clock.advance(1_000); // retry is re-signed later; the prepared core is reused
    const retry = await commitQuarantinedShards(opts);
    expect(retry.committedCids.length).toBe(5);

    const cosigners: string[] = [];
    for await (const record of store.iterate()) {
      if (record.type === "memory" && record.body.kind === "shard") {
        cosigners.push(...record.cosigners);
      }
    }
    expect(lostCosig).not.toBeNull();
    expect(cosigners).toContain(lostCosig);
    const v = await verifyChain(store, { doorPublicKeys: { [doorId]: DOOR.publicKey } });
    expect(v.valid).toBe(true);
    await handle.stop();
  });

  it("runtime restart without depart: new epoch arrival supersedes; out-1 accepted again; relay maps per epoch", async () => {
    const { gateway, clock, timer, store, doorId, handle, session } = await boot({
      reviewTimeoutMs: 10_000
    });
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

  it("depart retry while the review is in flight joins it (shards posted once)", async () => {
    let lose = true;
    let firstReview: Promise<unknown> = Promise.resolve();
    const { gateway, clock, handle, session, departOptions } = await boot({
      reviewTimeoutMs: 10_000,
      wrapDoor: (connection) =>
        withCosign(connection, async (request) => {
          if (lose && request.phase === "review") {
            lose = false;
            // The Door keeps reviewing; the runtime's HTTP call times out.
            firstReview = settled(connection.cosign(request));
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("HeadersTimeoutError");
          }
          return connection.cosign(request);
        })
    });
    await expect(session.depart(departOptions())).rejects.toThrow(/HeadersTimeoutError/u);
    expect(reviewPosts(gateway)).toBe(5);
    clock.advance(1000);
    const retry = session.depart(departOptions());
    await autoApproveReviews(gateway, settled(retry));
    const dep = await retry;
    await firstReview;
    expect(dep.approvedShardIds.length).toBe(5);
    expect(reviewPosts(gateway)).toBe(5);
    await handle.stop();
  });

  it("depart retry after the completed review's reply was lost gets the stored decisions", async () => {
    let lose = true;
    const { gateway, clock, handle, session, departOptions } = await boot({
      reviewTimeoutMs: 10_000,
      wrapDoor: (connection) =>
        withCosign(connection, async (request) => {
          const out = await connection.cosign(request);
          if (lose && request.phase === "review") {
            lose = false;
            throw new Error("ECONNRESET (response lost)");
          }
          return out;
        })
    });
    const first = session.depart(departOptions());
    await autoApproveReviews(gateway, settled(first));
    await expect(first).rejects.toThrow(/ECONNRESET/u);
    expect(reviewPosts(gateway)).toBe(5);
    clock.advance(1000);
    const dep = await session.depart(departOptions());
    expect(dep.approvedShardIds.length).toBe(5);
    expect(reviewPosts(gateway)).toBe(5);
    await handle.stop();
  });
});
