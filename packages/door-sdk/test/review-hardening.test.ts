import { connect } from "node:net";

import {
  canonicalize,
  contentAddressSideBlob,
  encodePublicKey,
  encodeShardTextBlob,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { Door } from "../src/door.js";
import type { HostPolicy } from "../src/policy.js";
import {
  DOOR_PROTOCOL_VERSION,
  OutboundReactionSchema,
  type AttestRequest,
  type CosignCandidateShard,
  type CosignRequest,
  type OutboundFrame
} from "../src/schemas.js";
import {
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  generateDoorKeypair,
  sessionBindSigningPayload,
  verifyDoorCosig
} from "../src/signing.js";
import {
  WS_CLOSE_REASON_MAX_BYTES,
  WS_MAX_PAYLOAD_BYTES,
  WS_SESSION_BIND_FAILED,
  WsDoorSessionServer,
  safeCloseReason
} from "../src/transports/ws.js";

const DOOR_ID = "discord:hardening";
const EPOCH = 5;
const NOW = "2026-07-20T15:10:00.000Z";
const RESIDENCY = `door:${DOOR_ID}/epoch:${String(EPOCH)}`;

const policy: HostPolicy = {
  community: { name: "x", description: "x", platform: "discord", invitation_required: false },
  capabilities: ["session.text", "attest", "heartbeat", "cosign.manual"]
};

class MutableClock {
  constructor(public value: string) {}

  now(): string {
    return this.value;
  }
}

function setup(options?: { decide?: (id: string) => "approved" | "rejected"; clock?: string }): {
  door: Door;
  soul: Ed25519Keypair;
  session: Ed25519Keypair;
  doorKp: Ed25519Keypair;
  clock: MutableClock;
} {
  const soul = generateKeypair();
  const session = generateKeypair();
  const doorKp = generateDoorKeypair();
  const clock = new MutableClock(options?.clock ?? NOW);
  const decide = options?.decide;
  const door = new Door({
    doorId: DOOR_ID,
    doorKeypair: doorKp,
    soulPublicKey: soul.publicKey,
    clock,
    policy: decide === undefined ? policy : { ...policy, decideShard: (s) => decide(s.shard_id) }
  });
  return { door, soul, session, doorKp, clock };
}

function coreString(value: unknown): string {
  return new TextDecoder().decode(canonicalize(value));
}

function attestationCore(
  kind: AttestRequest["kind"],
  options?: { epoch?: number; residency?: string; type?: string; sessionPubkey?: string }
): string {
  const epoch = options?.epoch ?? EPOCH;
  return coreString({
    spec: "osp/0.2",
    seq: 3,
    prev: "bafyprev",
    type: options?.type ?? "attestation",
    body: {
      kind,
      door_id: DOOR_ID,
      epoch,
      ...(options?.sessionPubkey === undefined ? {} : { session_pubkey: options.sessionPubkey })
    },
    residency: options?.residency ?? `door:${DOOR_ID}/epoch:${String(epoch)}`
  });
}

function attestReq(
  key: Ed25519Keypair,
  session: Ed25519Keypair,
  kind: AttestRequest["kind"],
  core: string,
  epoch = EPOCH
): AttestRequest {
  const fields = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: DOOR_ID,
    epoch,
    kind,
    core,
    session_pubkey: encodePublicKey(session.publicKey),
    issued_at: NOW
  };
  return { ...fields, sig: encodeSignature(sign(attestSigningPayload(fields), key.privateKey)) };
}

async function arrive(door: Door, soul: Ed25519Keypair, session: Ed25519Keypair): Promise<void> {
  await door.attest(attestReq(soul, session, "arrival", attestationCore("arrival")));
}

const SHARDS: CosignCandidateShard[] = Array.from({ length: 5 }, (_, i) => ({
  shard_id: `s${String(i + 1)}`,
  text: `I remember shard ${String(i + 1)}.`
}));

async function review(door: Door, session: Ed25519Keypair): Promise<void> {
  const fields = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    phase: "review" as const,
    door_id: DOOR_ID,
    epoch: EPOCH,
    session_pubkey: encodePublicKey(session.publicKey),
    shards: SHARDS,
    issued_at: NOW
  };
  await door.cosign({
    ...fields,
    sig: encodeSignature(sign(cosignReviewSigningPayload(fields), session.privateKey))
  });
}

function commitReq(
  session: Ed25519Keypair,
  shardId: string,
  core: string
): Extract<CosignRequest, { phase: "commit" }> {
  const fields = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    phase: "commit" as const,
    door_id: DOOR_ID,
    epoch: EPOCH,
    session_pubkey: encodePublicKey(session.publicKey),
    shard_id: shardId,
    core,
    issued_at: NOW
  };
  return {
    ...fields,
    sig: encodeSignature(sign(cosignCommitSigningPayload(fields), session.privateKey))
  };
}

/** osp/0.2 memory shard core referencing `text` by side-blob hash/CID (as the runtime builds it). */
async function memoryCore(
  text: string,
  options?: { seq?: number; residency?: string; type?: string; textCid?: string; prev?: string }
): Promise<string> {
  const blob = await contentAddressSideBlob(encodeShardTextBlob(text));
  return coreString({
    spec: "osp/0.2",
    seq: options?.seq ?? 10,
    prev: options?.prev ?? "bafyprev",
    type: options?.type ?? "memory",
    body: {
      kind: "shard",
      text_cid: options?.textCid ?? blob.cid,
      text_hash: blob.hash,
      candidate_cid: "bafycandidate",
      distilled_at: NOW
    },
    residency: options?.residency ?? RESIDENCY
  });
}

describe("attest core binding", () => {
  it("heartbeat attest refuses a memory core (no host cosig over unreviewed content)", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    const memory = await memoryCore("the host never saw this");
    await expect(
      door.attest(attestReq(session, session, "heartbeat", memory))
    ).rejects.toMatchObject({ code: "core_invalid", httpStatus: 400 });
  });

  it("rejects kind mismatch, foreign residency, wrong epoch body, and non-canonical core", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    const bad = [
      attestationCore("departure"),
      attestationCore("heartbeat", { residency: "door:discord:other/epoch:5" }),
      attestationCore("heartbeat", { residency: `door:${DOOR_ID}/epoch:6` }),
      attestationCore("heartbeat", { type: "memory" }),
      attestationCore("heartbeat", { sessionPubkey: encodePublicKey(generateKeypair().publicKey) }),
      ` ${attestationCore("heartbeat")}`,
      "not json"
    ];
    for (const core of bad) {
      await expect(
        door.attest(attestReq(session, session, "heartbeat", core))
      ).rejects.toMatchObject({ code: "core_invalid" });
    }
  });

  it("arrival with an unbound core installs no session", async () => {
    const { door, soul, session } = setup();
    await expect(
      door.attest(attestReq(soul, session, "arrival", '{"type":"attestation"}'))
    ).rejects.toMatchObject({ code: "core_invalid" });
    expect(door.getActiveEpoch()).toBeNull();
  });

  it("bound heartbeat / departure cores are co-signed", async () => {
    const { door, soul, session, doorKp } = setup();
    await arrive(door, soul, session);
    const core = attestationCore("heartbeat", {
      sessionPubkey: encodePublicKey(session.publicKey)
    });
    const res = await door.attest(attestReq(session, session, "heartbeat", core));
    expect(verifyDoorCosig(core, res.door_cosig, doorKp.publicKey)).toBe(true);
    await door.attest(attestReq(session, session, "departure", attestationCore("departure")));
    expect(door.getActiveEpoch()).toBeNull();
  });
});

describe("commit core binding", () => {
  it("cosigns a memory shard core whose text_hash/text_cid match the reviewed text", async () => {
    const { door, soul, session, doorKp } = setup();
    await arrive(door, soul, session);
    await review(door, session);
    const core = await memoryCore(SHARDS[0].text);
    const res = await door.cosign(commitReq(session, "s1", core));
    expect(res.phase === "commit" && verifyDoorCosig(core, res.door_cosig, doorKp.publicKey)).toBe(
      true
    );
  });

  it("rejects cores that do not reference the reviewed shard", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    await review(door, session);
    const otherCid = (await contentAddressSideBlob(encodeShardTextBlob("other"))).cid;
    const bad = [
      await memoryCore("the host never saw this"),
      await memoryCore(SHARDS[1].text),
      await memoryCore(SHARDS[0].text, { textCid: otherCid }),
      await memoryCore(SHARDS[0].text, { residency: `door:${DOOR_ID}/epoch:4` }),
      await memoryCore(SHARDS[0].text, { type: "attestation" }),
      '{"other":"also never reviewed"}',
      coreString({
        spec: "osp/0.1",
        seq: 10,
        prev: "bafyprev",
        type: "memory",
        body: { kind: "shard", text: "inline but different" },
        residency: RESIDENCY
      })
    ];
    for (const core of bad) {
      await expect(door.cosign(commitReq(session, "s1", core))).rejects.toMatchObject({
        code: "shard_invalid",
        httpStatus: 422
      });
    }
  });

  it("an approved shard_id is single-use per chain position", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    await review(door, session);
    const atTen = await memoryCore(SHARDS[0].text, { seq: 10 });
    await door.cosign(commitReq(session, "s1", atTen));
    // A different core at the same chain position (fork) is refused.
    await expect(
      door.cosign(commitReq(session, "s1", await memoryCore(SHARDS[0].text, { prev: "bafyfork" })))
    ).rejects.toMatchObject({ code: "shard_not_approved" });
    await expect(
      door.cosign(commitReq(session, "s1", await memoryCore(SHARDS[0].text, { seq: 9 })))
    ).rejects.toMatchObject({ code: "shard_not_approved" });
    // Runtime retry after the chain head moved: strictly later seq is accepted once.
    const atEleven = await memoryCore(SHARDS[0].text, { seq: 11 });
    await door.cosign(commitReq(session, "s1", atEleven));
    await expect(
      door.cosign(
        commitReq(session, "s1", await memoryCore(SHARDS[0].text, { seq: 11, prev: "bafyfork" }))
      )
    ).rejects.toMatchObject({ code: "shard_not_approved" });
    // The earlier position stays burned even for its original byte-identical core.
    await expect(door.cosign(commitReq(session, "s1", atTen))).rejects.toMatchObject({
      code: "shard_not_approved"
    });
  });

  it("a lost-reply commit retry (same seq, byte-identical core) gets the same door_cosig", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    await review(door, session);
    const atTen = await memoryCore(SHARDS[0].text, { seq: 10 });
    const first = await door.cosign(commitReq(session, "s1", atTen));
    const retry = await door.cosign(commitReq(session, "s1", atTen));
    expect(retry).toEqual(first);
  });
});

describe("outbound replay defense", () => {
  function outbound(session: Ed25519Keypair, msgId: string, issuedAt = NOW): OutboundFrame {
    const unsigned: Omit<OutboundFrame, "sig"> = {
      type: "outbound",
      door_id: DOOR_ID,
      epoch: EPOCH,
      msg_id: msgId,
      issued_at: issuedAt,
      body: { text: "hi" }
    };
    return { ...unsigned, sig: encodeSignature(sign(canonicalize(unsigned), session.privateKey)) };
  }

  it("rejects a replayed msg_id within the epoch", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    const frame = outbound(session, "out-1");
    door.handleOutbound(frame);
    expect(() => door.handleOutbound(frame)).toThrow(/msg_replay/);
    expect(() => door.handleOutbound(outbound(session, "out-2"))).not.toThrow();
  });

  it("rejects stale issued_at", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    expect(() =>
      door.handleOutbound(outbound(session, "out-1", "2020-01-01T00:00:00.000Z"))
    ).toThrow(/timestamp_stale/);
  });

  it("resets the seen set on a new arrival", async () => {
    const { door, soul, session } = setup();
    await arrive(door, soul, session);
    door.handleOutbound(outbound(session, "out-1"));
    const next = generateKeypair();
    const core = attestationCore("arrival", { epoch: EPOCH + 1 });
    await door.attest(attestReq(soul, next, "arrival", core, EPOCH + 1));
    const unsigned: Omit<OutboundFrame, "sig"> = {
      type: "outbound",
      door_id: DOOR_ID,
      epoch: EPOCH + 1,
      msg_id: "out-1",
      issued_at: NOW,
      body: { text: "new session" }
    };
    const frame = {
      ...unsigned,
      sig: encodeSignature(sign(canonicalize(unsigned), next.privateKey))
    };
    expect(() => door.handleOutbound(frame)).not.toThrow();
  });
});

describe("reaction emoji keycaps", () => {
  const ok = (emoji: string): boolean =>
    OutboundReactionSchema.safeParse({ emoji, target_msg_id: "m" }).success;

  it("accepts real keycaps only", () => {
    for (const emoji of ["1️⃣", "1⃣", "#️⃣", "*️⃣", "👍🏽"]) {
      expect(ok(emoji)).toBe(true);
    }
    for (const emoji of ["a⃣", "⃣", "😀⃣", "12⃣", "a️⃣"]) {
      expect(ok(emoji)).toBe(false);
    }
  });
});

describe("WS session server hardening", () => {
  let server: WsDoorSessionServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function startServer(): Promise<{
    port: number;
    url: string;
    door: Door;
    soul: Ed25519Keypair;
    session: Ed25519Keypair;
  }> {
    const { door, soul, session } = setup();
    server = new WsDoorSessionServer({ door });
    const info = await server.start();
    return { port: info.port, url: info.url, door, soul, session };
  }

  function bindQuery(session: Ed25519Keypair, doorId = DOOR_ID, epoch = EPOCH): string {
    const sessionPubkey = encodePublicKey(session.publicKey);
    const sig = sign(
      sessionBindSigningPayload({ door_id: doorId, epoch, session_pubkey: sessionPubkey }),
      session.privateKey
    );
    return new URLSearchParams({
      door_id: doorId,
      epoch: String(epoch),
      session_pubkey: sessionPubkey,
      session_sig: encodeSignature(sig)
    }).toString();
  }

  /** Raw upgrade followed by an unmasked (protocol-violating) client text frame. */
  function rawUpgradeWithUnmaskedFrame(port: number, query: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /door/session${query === "" ? "" : `?${query}`} HTTP/1.1\r\nHost: x\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
      });
      socket.on("data", () => undefined);
      socket.on("error", () => undefined);
      socket.on("close", () => resolve());
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 500);
    });
  }

  function closeInfo(url: string): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("error", () => undefined);
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
      setTimeout(() => reject(new Error("close timeout")), 3000);
    });
  }

  it("bare upgrade (no params) closes 4401 with a short reason and the server keeps serving", async () => {
    const { url } = await startServer();
    for (let i = 0; i < 2; i += 1) {
      const info = await closeInfo(url);
      expect(info.code).toBe(WS_SESSION_BIND_FAILED);
      expect(Buffer.byteLength(info.reason)).toBeLessThanOrEqual(WS_CLOSE_REASON_MAX_BYTES);
    }
  });

  it("long DoorError text from bindSession never reaches the close reason", async () => {
    const { url, session } = await startServer();
    const longDoorId = `discord:${"9".repeat(3000)}`;
    const info = await closeInfo(`${url}?${bindQuery(session, longDoorId)}`);
    expect(info.code).toBe(WS_SESSION_BIND_FAILED);
    expect(info.reason).toBe("session bind failed: session_invalid");
  });

  it("unmasked frames (unbound and bound sockets) do not crash the process", async () => {
    const { port, url, door, soul, session } = await startServer();
    await arrive(door, soul, session);
    await rawUpgradeWithUnmaskedFrame(port, "");
    await rawUpgradeWithUnmaskedFrame(port, bindQuery(generateKeypair()));
    await rawUpgradeWithUnmaskedFrame(port, bindQuery(session));
    // Still serving: a fresh bare upgrade is answered with 4401.
    expect((await closeInfo(url)).code).toBe(WS_SESSION_BIND_FAILED);
  });

  it("oversized frames are refused without taking the server down", async () => {
    const { url, door, soul, session } = await startServer();
    await arrive(door, soul, session);
    const ws = new WebSocket(`${url}?${bindQuery(session)}`);
    ws.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("close", () => reject(new Error("closed before open")));
    });
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send("x".repeat(WS_MAX_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009);
    expect((await closeInfo(url)).code).toBe(WS_SESSION_BIND_FAILED);
  });

  it("safeCloseReason truncates on code-point boundaries", () => {
    const reason = safeCloseReason("é".repeat(200));
    expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(WS_CLOSE_REASON_MAX_BYTES);
    expect(reason).toBe("é".repeat(61));
    expect(safeCloseReason("short")).toBe("short");
    expect(Buffer.byteLength(safeCloseReason("😀".repeat(40)))).toBe(120);
  });
});
