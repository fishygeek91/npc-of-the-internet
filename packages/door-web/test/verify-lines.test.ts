import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";

import type { OutboundFrame } from "@npc/door-sdk";
import {
  createRecord,
  encodePublicKey,
  generateKeypair,
  OSP_SPEC_V02,
  POP_VERSION,
  signCore,
  type Ed25519Keypair,
  type OspRecord
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import type { OutboundProof } from "../src/browser/proof.js";
import { fetchChain, verifyText } from "../src/browser/verify-porch.js";
import { signedOutbound } from "./helpers.js";

const DOOR_ID = "web:test";

describe("porch line verification", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  it("accepts a real session signature and rejects a wrong key, a tampered byte, and mismatched text", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const records = await arrivalChain(soul, door, session);
    const served = await serveExport({
      records,
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
      blobs: {}
    });
    closers.push(served.close);

    const cache = await fetchChain(pins(soul, door, served.url), null);
    expect(cache.hold.phase).toBe("verified");

    const hello = proofFrom(
      signedOutbound({
        session,
        doorId: DOOR_ID,
        epoch: 1,
        msgId: "out-1",
        body: { text: "Hello" }
      })
    );
    expect(verifyText(cache.hold, { from: "wanderer", text: "Hello", proof: hello })).toBe(
      "verified"
    );
    expect(verifyText(cache.hold, { from: "visitor", text: "Hello", proof: hello })).toBe("plain");
    expect(verifyText(cache.hold, { from: "system", text: "The Wanderer has arrived." })).toBe(
      "plain"
    );
    expect(verifyText(cache.hold, { from: "wanderer", text: "Hello" })).toBe("failed");

    const wrong = proofFrom(
      signedOutbound({
        session: generateKeypair(),
        doorId: DOOR_ID,
        epoch: 1,
        msgId: "out-2",
        body: { text: "Hello" }
      })
    );
    expect(verifyText(cache.hold, { from: "wanderer", text: "Hello", proof: wrong })).toBe(
      "failed"
    );

    const tampered: OutboundProof = {
      signed: {
        ...hello.signed,
        body: { text: "Hellp" }
      },
      sig: hello.sig
    };
    expect(verifyText(cache.hold, { from: "wanderer", text: "Hellp", proof: tampered })).toBe(
      "failed"
    );
    expect(verifyText(cache.hold, { from: "wanderer", text: "Hello!", proof: hello })).toBe(
      "failed"
    );
  });

  it("fails the line when the chain is invalid or the pinned door key does not match", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const records = await arrivalChain(soul, door, session);
    const genesis = records[0];
    if (genesis === undefined) {
      throw new Error("missing genesis");
    }
    const broken = records.map((record, index) =>
      index === 0
        ? {
            ...record,
            sig: record.sig.endsWith("A")
              ? `${record.sig.slice(0, -1)}B`
              : `${record.sig.slice(0, -1)}A`
          }
        : record
    );
    const invalid = await serveExport({
      records: broken,
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
      blobs: {}
    });
    closers.push(invalid.close);
    const invalidCache = await fetchChain(pins(soul, door, invalid.url), null);
    expect(invalidCache.hold.phase).toBe("failed");
    const hello = proofFrom(
      signedOutbound({
        session,
        doorId: DOOR_ID,
        epoch: 1,
        msgId: "out-1",
        body: { text: "Hello" }
      })
    );
    expect(verifyText(invalidCache.hold, { from: "wanderer", text: "Hello", proof: hello })).toBe(
      "failed"
    );

    const mismatched = await serveExport({
      records,
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(generateKeypair().publicKey) },
      blobs: {}
    });
    closers.push(mismatched.close);
    const mismatch = await fetchChain(pins(soul, door, mismatched.url), null);
    expect(mismatch.hold.phase).toBe("failed");

    const offline = await fetchChain(pins(soul, door, null), null);
    expect(offline.hold.phase).toBe("failed");
  });

  it("keeps the verified snapshot when the export answers 304", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = generateKeypair();
    const records = await arrivalChain(soul, door, session);
    const served = await serveExport(
      {
        records,
        doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
        blobs: {}
      },
      { etag: '"chain"' }
    );
    closers.push(served.close);
    const first = await fetchChain(pins(soul, door, served.url), null);
    expect(first.hold.phase).toBe("verified");
    expect(first.etag).toBe('"chain"');
    const again = await fetchChain(pins(soul, door, served.url), first);
    expect(again.hold).toBe(first.hold);
  });
});

describe("porch page source", () => {
  it("labels failed lines and does not parse chain text as HTML", () => {
    const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(source).toContain("verification failed");
    expect(source).not.toContain("innerHTML");
  });
});

function pins(soul: Ed25519Keypair, door: Ed25519Keypair, atlasUrl: string | null) {
  return {
    soulPublicKey: encodePublicKey(soul.publicKey),
    doorId: DOOR_ID,
    doorPublicKey: encodePublicKey(door.publicKey),
    atlasUrl
  };
}

function proofFrom(frame: OutboundFrame): OutboundProof {
  const body: OutboundProof["signed"]["body"] = {};
  if (frame.body.text !== undefined) {
    body.text = frame.body.text;
  }
  if (frame.body.reply_to !== undefined) {
    body.reply_to = frame.body.reply_to;
  }
  if (frame.body.reaction !== undefined) {
    body.reaction = {
      emoji: frame.body.reaction.emoji,
      target_msg_id: frame.body.reaction.target_msg_id
    };
  }
  return {
    signed: {
      type: "outbound",
      door_id: frame.door_id,
      epoch: frame.epoch,
      msg_id: frame.msg_id,
      issued_at: frame.issued_at,
      body
    },
    sig: frame.sig
  };
}

async function arrivalChain(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  session: Ed25519Keypair
): Promise<OspRecord[]> {
  const genesis = await createRecord({
    spec: OSP_SPEC_V02,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nI travel.",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
  const fields = {
    spec: OSP_SPEC_V02,
    seq: 1,
    prev: genesis.cid,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: POP_VERSION,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: encodePublicKey(session.publicKey),
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: `door:${DOOR_ID}/epoch:1`
  };
  const arrival = await createRecord({
    ...fields,
    cosigners: [signCore(fields, door.privateKey)],
    soulPrivateKey: soul.privateKey
  });
  return [genesis.record, arrival.record];
}

function serveExport(
  body: unknown,
  options: { etag?: string } = {}
): Promise<{ url: string; close: () => Promise<void> }> {
  const etag = options.etag ?? '"export"';
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path !== "/chain/export") {
      response.writeHead(404);
      response.end();
      return;
    }
    const inm = request.headers["if-none-match"];
    if (inm === etag) {
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
