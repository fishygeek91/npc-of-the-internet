import { createServer, type Server } from "node:http";

import { outboundSigningPayload, type OutboundFrame } from "@npc/door-sdk";
import {
  createRecord,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  OSP_SPEC_V02,
  POP_VERSION,
  sign,
  signCore,
  type CreateRecordInput,
  type Ed25519Keypair,
  type OspRecord
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import type { OutboundProof } from "../src/browser/proof.js";
import {
  fetchChain,
  lineAwaitsEpoch,
  verifyReaction,
  verifyText,
  type ChainHold,
  type LineVerdict
} from "../src/browser/verify-porch.js";
import { signedOutbound } from "./helpers.js";

const DOOR_ID = "web:test";
const OTHER_DOOR = "web:other";

describe("porch line verification", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  it("accepts a real session signature and rejects a bad line, reaction, or proof", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const hold = await holdOf(closers, soul, door, session, async () => undefined);
    const hello = speak(session);
    expect(wanderer(hold, hello)).toBe("verified");
    expect(verifyText(hold, { from: "visitor", text: "Hello", proof: hello })).toBe("plain");
    expect(verifyText(hold, { from: "system", text: "The Wanderer has arrived." })).toBe("plain");
    expect(verifyText(hold, { from: "wanderer", text: "Hello" })).toBe("failed");
    expect(wanderer(hold, speak(generateKeypair()))).toBe("failed");
    const tampered: OutboundProof = {
      signed: { ...hello.signed, body: { text: "Hellp", channel_id: "porch" } },
      sig: hello.sig
    };
    expect(wanderer(hold, tampered, "Hellp")).toBe("failed");
    expect(wanderer(hold, hello, "Hello!")).toBe("failed");
    expect(wanderer(hold, speak(session, 2, DOOR_ID, "Later"), "Later")).toBe("checking");

    const loose = {
      type: "outbound" as const,
      door_id: DOOR_ID,
      epoch: 1,
      msg_id: "out-future",
      issued_at: "2026-01-03T00:00:00.000Z",
      body: { text: "Kept", channel_id: "porch", future: "field" }
    };
    expect(
      wanderer(
        hold,
        {
          signed: loose,
          sig: encodeSignature(sign(outboundSigningPayload(loose), session.privateKey))
        },
        "Kept"
      )
    ).toBe("verified");

    const reaction = chip(session);
    expect(verifyReaction(hold, "web-1", { emoji: "👍", proof: reaction })).toBe("verified");
    expect(verifyReaction(hold, "web-1", { emoji: "👎", proof: reaction })).toBe("failed");
    expect(verifyReaction(hold, "web-2", { emoji: "👍", proof: reaction })).toBe("failed");
    expect(verifyReaction(hold, "web-1", { emoji: "👍", proof: hello })).toBe("failed");
    expect(verifyReaction(hold, "web-1", { emoji: "👍", proof: chip(generateKeypair()) })).toBe(
      "failed"
    );

    const missingBody = {
      signed: {
        type: "outbound",
        door_id: DOOR_ID,
        epoch: 1,
        msg_id: "x",
        issued_at: "2026-01-01T00:00:00.000Z"
      },
      sig: "abc"
    };
    const wrongTypes = {
      signed: {
        type: "outbound",
        door_id: 1,
        epoch: "2",
        msg_id: false,
        issued_at: null,
        body: null
      },
      sig: 12
    };
    const extraSig = { signed: { ...hello.signed, sig: hello.sig }, sig: hello.sig };
    for (const proof of [missingBody, wrongTypes, extraSig, null]) {
      expect(wanderer(hold, proof)).toBe("failed");
      expect(verifyReaction(hold, "web-1", { emoji: "👍", proof })).toBe("failed");
    }
  });

  it("fails the line when the chain is invalid or the pinned door key does not match", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const chain = await startChain(soul);
    await arrive(chain, soul, door, session, DOOR_ID, 1, "2026-01-02T00:00:00.000Z");
    const genesis = chain.records[0];
    if (genesis === undefined) {
      throw new Error("missing genesis");
    }
    const broken = chain.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            sig: record.sig.endsWith("A")
              ? `${record.sig.slice(0, -1)}B`
              : `${record.sig.slice(0, -1)}A`
          }
        : record
    );
    const invalid = await serveExport({ records: broken, doorPublicKeys: keyMap(door), blobs: {} });
    closers.push(invalid.close);
    const invalidCache = await fetchChain(pins(soul, door, invalid.url), null);
    expect(invalidCache.hold.phase).toBe("failed");
    expect(wanderer(invalidCache.hold, speak(session))).toBe("failed");

    const mismatched = await serveExport({
      records: chain.records,
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(generateKeypair().publicKey) },
      blobs: {}
    });
    closers.push(mismatched.close);
    expect((await fetchChain(pins(soul, door, mismatched.url), null)).hold.phase).toBe("failed");
    expect((await fetchChain(pins(soul, door, null), null)).hold.phase).toBe("failed");
  });

  it("keeps a verified snapshot on 304 and drops it after a failed fetch", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const chain = await startChain(soul);
    await arrive(chain, soul, door, session, DOOR_ID, 1, "2026-01-02T00:00:00.000Z");
    const seen: string[] = [];
    const served = await serveExport(
      { records: chain.records, doorPublicKeys: keyMap(door), blobs: {} },
      { etag: '"chain"', seen }
    );
    closers.push(served.close);
    const porch = pins(soul, door, served.url);
    const first = await fetchChain(porch, null);
    expect(first.hold.phase).toBe("verified");
    expect(first.etag).toBe('"chain"');
    const again = await fetchChain(porch, first);
    expect(again.hold).toBe(first.hold);

    let blows = true;
    const flaky: typeof fetch = (input, init) => {
      if (blows) {
        blows = false;
        return Promise.reject(new Error("blip"));
      }
      return fetch(input, init);
    };
    const hello = speak(session);
    const failed = await fetchChain(porch, first, flaky);
    expect(failed.etag).toBeNull();
    expect(failed.hold.phase).toBe("failed");
    expect(wanderer(failed.hold, hello)).toBe("failed");
    const recovered = await fetchChain(porch, failed, flaky);
    expect(recovered.hold.phase).toBe("verified");
    expect(wanderer(recovered.hold, hello)).toBe("verified");
    expect(seen).toEqual(["", '"chain"', ""]);
  });

  it("marks a closed, sleeping, or superseded stay as an earlier visit and fails another door", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const hello = speak(session);
    for (const kind of ["departure", "travel", "handover"] as const) {
      const closed = await holdOf(closers, soul, door, session, (chain) =>
        closeStay(chain, soul, door, kind)
      );
      expect(wanderer(closed, hello)).toBe("earlier");
    }

    const sleeping = await holdOf(closers, soul, door, session, (chain) => doSleep(chain, soul));
    expect(wanderer(sleeping, hello)).toBe("earlier");

    const awake = await holdOf(closers, soul, door, session, async (chain) => {
      await doSleep(chain, soul);
      await append(chain, soul, door, {
        type: "attestation",
        body: {
          kind: "heartbeat",
          pop_version: POP_VERSION,
          door_id: DOOR_ID,
          epoch: 1,
          session_pubkey: encodePublicKey(session.publicKey),
          at: "2026-01-04T00:00:00.000Z"
        },
        residency: `door:${DOOR_ID}/epoch:1`
      });
    });
    expect(wanderer(awake, hello)).toBe("verified");

    const next = generateKeypair();
    const newer = await holdOf(closers, soul, door, session, (chain) =>
      arrive(chain, soul, door, next, DOOR_ID, 2, "2026-01-05T00:00:00.000Z")
    );
    expect(wanderer(newer, hello)).toBe("earlier");
    expect(wanderer(newer, speak(next, 2))).toBe("verified");

    const otherDoor = generateKeypair();
    const otherSession = generateKeypair();
    const elsewhere = await holdOf(
      closers,
      soul,
      door,
      session,
      async (chain) => {
        await closeStay(chain, soul, door, "departure");
        await arrive(
          chain,
          soul,
          otherDoor,
          otherSession,
          OTHER_DOOR,
          2,
          "2026-01-06T00:00:00.000Z"
        );
      },
      { ...keyMap(door), [OTHER_DOOR]: encodePublicKey(otherDoor.publicKey) }
    );
    expect(wanderer(elsewhere, speak(otherSession, 2, OTHER_DOOR))).toBe("failed");
    expect(wanderer(elsewhere, hello)).toBe("earlier");
  });

  it("checks a newer epoch until its arrival is on the chain, then verifies it", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const next = generateKeypair();
    const again = speak(next, 2, DOOR_ID, "Again");
    const stale = await holdOf(closers, soul, door, session, async () => undefined);
    expect(wanderer(stale, again, "Again")).toBe("checking");
    expect(lineAwaitsEpoch(stale, { from: "wanderer", text: "Again", proof: again })).toBe(true);
    expect(lineAwaitsEpoch(stale, { from: "wanderer", text: "Nope", proof: again })).toBe(false);
    expect(wanderer(stale, again, "Nope")).toBe("failed");
    expect(wanderer(stale, speak(next, 9, OTHER_DOOR, "Nope"), "Nope")).toBe("failed");
    const forged = chip(generateKeypair(), 999999);
    expect(verifyReaction(stale, "web-1", { emoji: "👍", proof: forged })).toBe("checking");

    const current = await holdOf(closers, soul, door, session, (chain) =>
      arrive(chain, soul, door, next, DOOR_ID, 2, "2026-01-05T00:00:00.000Z")
    );
    expect(wanderer(current, again, "Again")).toBe("verified");
    expect(wanderer(current, speak(session))).toBe("earlier");
    const hello = speak(session);
    const tampered: OutboundProof = {
      signed: { ...hello.signed, body: { text: "Hellp", channel_id: "porch" } },
      sig: hello.sig
    };
    expect(wanderer(current, tampered, "Hellp")).toBe("failed");
    expect(wanderer(current, speak(generateKeypair()))).toBe("failed");
    expect(verifyReaction(current, "web-1", { emoji: "👍", proof: chip(session) })).toBe("earlier");

    const otherDoor = generateKeypair();
    const elsewhere = await holdOf(
      closers,
      soul,
      door,
      session,
      async (chain) => {
        await closeStay(chain, soul, door, "departure");
        await arrive(
          chain,
          soul,
          otherDoor,
          generateKeypair(),
          OTHER_DOOR,
          2,
          "2026-01-06T00:00:00.000Z"
        );
      },
      { ...keyMap(door), [OTHER_DOOR]: encodePublicKey(otherDoor.publicKey) }
    );
    expect(wanderer(elsewhere, speak(next, 2))).toBe("failed");
    expect(wanderer(elsewhere, speak(next, 3, DOOR_ID, "Soon"), "Soon")).toBe("checking");
  });
});

type ChainCursor = { records: OspRecord[]; prev: string | null; seq: number };

function pins(soul: Ed25519Keypair, door: Ed25519Keypair, atlasUrl: string | null) {
  return {
    soulPublicKey: encodePublicKey(soul.publicKey),
    doorId: DOOR_ID,
    doorPublicKey: encodePublicKey(door.publicKey),
    atlasUrl
  };
}

function keyMap(door: Ed25519Keypair): Record<string, string> {
  return { [DOOR_ID]: encodePublicKey(door.publicKey) };
}

function proofFrom(frame: OutboundFrame): OutboundProof {
  const { sig, ...signed } = frame;
  return { signed, sig };
}

function wanderer(hold: ChainHold, proof: unknown, text = "Hello"): LineVerdict {
  return verifyText(hold, { from: "wanderer", text, proof });
}

function speak(
  session: Ed25519Keypair,
  epoch = 1,
  doorId = DOOR_ID,
  text = "Hello"
): OutboundProof {
  return proofFrom(
    signedOutbound({
      session,
      doorId,
      epoch,
      msgId: "out-1",
      body: { text, channel_id: "porch" }
    })
  );
}

function chip(session: Ed25519Keypair, epoch = 1): OutboundProof {
  return proofFrom(
    signedOutbound({
      session,
      doorId: DOOR_ID,
      epoch,
      msgId: "out-r",
      body: { channel_id: "porch", reaction: { emoji: "👍", target_msg_id: "web-1" } }
    })
  );
}

async function holdOf(
  closers: Array<() => Promise<void>>,
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair,
  extend: (chain: ChainCursor) => Promise<void>,
  doorPublicKeys: Record<string, string> = keyMap(door)
): Promise<ChainHold> {
  const chain = await startChain(soul);
  await arrive(chain, soul, door, session, DOOR_ID, 1, "2026-01-02T00:00:00.000Z");
  await extend(chain);
  const served = await serveExport({ records: chain.records, doorPublicKeys, blobs: {} });
  closers.push(served.close);
  const cache = await fetchChain(pins(soul, door, served.url), null);
  expect(cache.hold.phase).toBe("verified");
  return cache.hold;
}

async function startChain(soul: Ed25519Keypair): Promise<ChainCursor> {
  const chain: ChainCursor = { records: [], prev: null, seq: 0 };
  await append(chain, soul, null, {
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nI travel.",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null
  });
  return chain;
}

async function arrive(
  chain: ChainCursor,
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair,
  doorId: string,
  epoch: number,
  at: string
): Promise<void> {
  await append(chain, soul, door, {
    type: "attestation",
    body: {
      kind: "arrival",
      pop_version: POP_VERSION,
      door_id: doorId,
      epoch,
      session_pubkey: encodePublicKey(session.publicKey),
      at
    },
    residency: `door:${doorId}/epoch:${String(epoch)}`
  });
}

async function doSleep(chain: ChainCursor, soul: Ed25519Keypair): Promise<void> {
  await append(chain, soul, null, {
    type: "sleep",
    body: {
      reason: "balance_below_threshold",
      balance: "0.10",
      threshold: "1.00",
      as_of: "2026-01-03T00:00:00.000Z"
    },
    residency: `door:${DOOR_ID}/epoch:1`
  });
}

async function closeStay(
  chain: ChainCursor,
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  kind: "departure" | "travel" | "handover"
): Promise<void> {
  const at = "2026-01-03T00:00:00.000Z";
  const residency = `door:${DOOR_ID}/epoch:1`;
  if (kind === "departure") {
    await append(chain, soul, door, {
      type: "attestation",
      body: { kind, pop_version: POP_VERSION, door_id: DOOR_ID, epoch: 1, at },
      residency
    });
    return;
  }
  if (kind === "travel") {
    await append(chain, soul, null, {
      type: "attestation",
      body: {
        kind,
        pop_version: POP_VERSION,
        from_door_id: DOOR_ID,
        from_epoch: 1,
        to_door_id: OTHER_DOOR,
        at
      },
      residency
    });
    return;
  }
  await append(chain, soul, null, {
    type: "attestation",
    body: {
      kind,
      pop_version: POP_VERSION,
      depart_door_id: DOOR_ID,
      arrive_door_id: OTHER_DOOR,
      depart_epoch: 1,
      arrive_epoch: 2,
      at
    },
    residency
  });
}

async function append(
  chain: ChainCursor,
  soul: Ed25519Keypair,
  door: Ed25519Keypair | null,
  input: {
    type: CreateRecordInput["type"];
    body: CreateRecordInput["body"];
    residency: string | null;
  }
): Promise<void> {
  const fields = {
    spec: OSP_SPEC_V02,
    seq: chain.seq,
    prev: chain.prev,
    type: input.type,
    body: input.body,
    residency: input.residency
  };
  const created = await createRecord({
    ...fields,
    cosigners: door === null ? [] : [signCore(fields, door.privateKey)],
    soulPrivateKey: soul.privateKey
  });
  chain.records.push(created.record);
  chain.prev = created.cid;
  chain.seq += 1;
}

function serveExport(
  body: unknown,
  options: { etag?: string; seen?: string[] } = {}
): Promise<{ url: string; close: () => Promise<void> }> {
  const etag = options.etag ?? '"export"';
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path !== "/chain/export") {
      response.writeHead(404);
      response.end();
      return;
    }
    const header = request.headers["if-none-match"];
    options.seen?.push(typeof header === "string" ? header : "");
    if (header === etag) {
      response.writeHead(304, { ETag: etag });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", ETag: etag });
    response.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("export server failed to bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          })
      });
    });
  });
}
