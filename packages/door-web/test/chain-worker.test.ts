import {
  decodeBase64Url,
  decodePublicKey,
  encodeBase64Url,
  encodePublicKey,
  generateKeypair,
  POP_VERSION
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { installChainWorker } from "../src/browser/chain-worker.js";
import type { WorkerVerifyReply } from "../src/browser/incremental-chain.js";
import { appendRecord, DOOR_ID, RESIDENCY, type ChainCursor } from "./shrine-fixture.js";

describe("installChainWorker", () => {
  it("resets, continues a tail, and drops the verifier when a signature is bad", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const session = encodePublicKey(generateKeypair().publicKey);
    const chain: ChainCursor = { records: [], prev: null, seq: 0 };
    await appendRecord(chain, soul, null, {
      type: "genesis",
      body: {
        charter: "# Wanderer\n\nI travel.",
        soul_pubkey: encodePublicKey(soul.publicKey),
        created_at: "2026-01-01T00:00:00.000Z"
      },
      residency: null
    });
    await appendRecord(chain, soul, door, {
      type: "attestation",
      body: {
        kind: "arrival",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: session,
        at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY
    });
    const prefix = chain.records.slice();
    await appendRecord(chain, soul, door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: session,
        at: "2026-01-02T00:00:01.000Z"
      },
      residency: RESIDENCY
    });
    const tail = chain.records[chain.records.length - 1];
    const atTail: ChainCursor = {
      records: chain.records.slice(),
      prev: chain.prev,
      seq: chain.seq
    };
    await appendRecord(chain, soul, door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: session,
        at: "2026-01-02T00:00:02.000Z"
      },
      residency: RESIDENCY
    });
    const badSource = chain.records[chain.records.length - 1];
    await appendRecord(atTail, soul, door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: session,
        at: "2026-01-02T00:00:03.000Z"
      },
      residency: RESIDENCY
    });
    const later = atTail.records[atTail.records.length - 1];
    if (tail === undefined || badSource === undefined || later === undefined) {
      throw new Error("missing heartbeat");
    }
    const keys = { [DOOR_ID]: decodePublicKey(encodePublicKey(door.publicKey)) };
    const replies: WorkerVerifyReply[] = [];
    let illegal = 0;
    let onmessage: ((event: { data: unknown }) => void) | null = null;
    let waiter: (() => void) | null = null;
    const host = {
      importScripts(this: unknown) {
        if (this !== host) {
          illegal += 1;
          throw new TypeError("Illegal invocation");
        }
      },
      postMessage(this: unknown, message: WorkerVerifyReply) {
        if (this !== host) {
          illegal += 1;
          throw new TypeError("Illegal invocation");
        }
        replies.push(message);
        const done = waiter;
        waiter = null;
        if (done !== null) {
          done();
        }
      },
      get onmessage() {
        return onmessage;
      },
      set onmessage(handler: ((event: { data: unknown }) => void) | null) {
        onmessage = handler;
      }
    };
    installChainWorker(host);

    async function deliver(data: unknown): Promise<WorkerVerifyReply> {
      const before = replies.length;
      await new Promise<void>((resolve) => {
        waiter = resolve;
        const handler = onmessage;
        if (handler === null) {
          throw new Error("worker was not installed");
        }
        handler({ data });
      });
      const reply = replies[before];
      if (reply === undefined) {
        throw new Error("worker did not reply");
      }
      return reply;
    }

    const malformed = await deliver({ hello: "no" });
    expect(malformed).toEqual({ id: 0, ok: false, fed: 0, head: null });

    const early = await deliver({ id: 1, reset: false, records: [tail], doorPublicKeys: keys });
    expect(early.ok).toBe(false);
    expect(early.id).toBe(1);

    const reset = await deliver({ id: 2, reset: true, records: prefix, doorPublicKeys: keys });
    expect(reset.ok).toBe(true);
    expect(reset.fed).toBe(prefix.length);
    expect(reset.head?.seq).toBe(prefix.length - 1);

    const continued = await deliver({ id: 3, reset: false, records: [tail], doorPublicKeys: keys });
    expect(continued.ok).toBe(true);
    expect(continued.fed).toBe(1);
    expect(continued.head?.seq).toBe(prefix.length);

    const rejected = await deliver({
      id: 4,
      reset: false,
      records: [flipSignature(badSource)],
      doorPublicKeys: keys
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.id).toBe(4);

    const dropped = await deliver({ id: 5, reset: false, records: [later], doorPublicKeys: keys });
    expect(dropped.ok).toBe(false);
    expect(dropped.id).toBe(5);
    expect(illegal).toBe(0);
  });
});

function flipSignature(record: { sig: string }): unknown {
  const bytes = Uint8Array.from(decodeBase64Url(record.sig));
  const index = bytes.length - 1;
  const last = bytes[index];
  if (last === undefined) {
    throw new Error("empty signature");
  }
  bytes[index] = last ^ 0xff;
  return { ...record, sig: encodeBase64Url(bytes) };
}
