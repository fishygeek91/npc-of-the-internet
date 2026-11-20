import { decodeBase64Url, encodeBase64Url, POP_VERSION } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { installChainWorker } from "../src/browser/chain-worker.js";
import type { WorkerVerifyReply } from "../src/browser/incremental-chain.js";
import {
  appendRecord,
  buildChain,
  DOOR_ID,
  RESIDENCY,
  type ChainCursor
} from "./shrine-fixture.js";

describe("installChainWorker", () => {
  it("resets, continues a tail, and drops the verifier when a signature is bad", async () => {
    const built = await buildChain(1);
    const prefix = built.records.slice(0, built.records.length - 1);
    const tail = built.records[built.records.length - 1];
    const chain: ChainCursor = {
      records: built.records.slice(),
      prev: built.prev,
      seq: built.seq
    };
    const atTail: ChainCursor = {
      records: built.records.slice(),
      prev: built.prev,
      seq: built.seq
    };
    await appendRecord(chain, built.soul, built.door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: built.session,
        at: "2026-01-02T00:00:02.000Z"
      },
      residency: RESIDENCY
    });
    const badSource = chain.records[chain.records.length - 1];
    await appendRecord(atTail, built.soul, built.door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: built.session,
        at: "2026-01-02T00:00:03.000Z"
      },
      residency: RESIDENCY
    });
    const later = atTail.records[atTail.records.length - 1];
    if (tail === undefined || badSource === undefined || later === undefined) {
      throw new Error("missing heartbeat");
    }
    const keys = { [DOOR_ID]: built.doorBytes };
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
