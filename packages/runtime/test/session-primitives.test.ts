import { describe, expect, it } from "vitest";

import { SingleKeyKeyring } from "../src/keyring/single-key-keyring.js";
import type { Keyring, SessionSigner } from "../src/keyring/types.js";
import { AppendQueue } from "../src/session/append-queue.js";
import { sealRecord } from "../src/session/attest.js";
import { SessionError } from "../src/session/errors.js";
import { HeartbeatPump, type HeartbeatPumpDeps } from "../src/session/heartbeat-pump.js";
import type { Clock, DoorConnection } from "../src/session/types.js";
import { createGenesisRecord, DOOR_ID, RESIDENCY } from "./helpers/fixtures.js";
import { SOUL } from "./helpers/fixed-keys.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const AT = "2026-07-20T00:00:00.000Z";

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AppendQueue", () => {
  it("runs jobs one at a time and does not let a rejection block the tail", async () => {
    const queue = new AppendQueue();
    const gate = defer();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });
    const second = queue.enqueue(async () => {
      order.push("second");
      return "ok";
    });
    const failed = queue.enqueue(async () => {
      throw new Error("boom");
    });
    const after = queue.enqueue(async () => "after");

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    gate.resolve();
    await first;
    await expect(second).resolves.toBe("ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("after");
    await expect(queue.settled()).resolves.toBeUndefined();
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("sealRecord", () => {
  it("pins osp/0.2, wraps SchemaError, and rethrows other failures", async () => {
    const genesis = await createGenesisRecord(SOUL);
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const sealed = await sealRecord(keyring, {
      seq: 1,
      prev: genesis.cid,
      type: "memory",
      body: { kind: "rejected", category: "pii.email", rejected_at: AT },
      residency: RESIDENCY,
      cosigners: []
    });
    expect(sealed.record.spec).toBe("osp/0.2");
    expect(sealed.record.prev).toBe(genesis.cid);

    const invalid = sealRecord(keyring, {
      seq: 1,
      prev: null,
      type: "genesis",
      body: { reason: "broke", balance: "0", threshold: "1", as_of: AT },
      residency: RESIDENCY,
      cosigners: []
    });
    await expect(invalid).rejects.toBeInstanceOf(SessionError);
    await expect(invalid).rejects.toThrow(/^invalid record: /u);

    const boom = new Error("sign failed");
    const failing: Keyring = {
      signWithSoulKey(): Uint8Array {
        throw boom;
      },
      deriveSessionKey(): SessionSigner {
        throw new Error("not used");
      },
      getSoulPublicKey(): Uint8Array {
        return SOUL.publicKey;
      }
    };
    await expect(
      sealRecord(failing, {
        seq: 0,
        prev: null,
        type: "genesis",
        body: { charter: "x", soul_pubkey: "k", created_at: AT },
        residency: null,
        cosigners: []
      })
    ).rejects.toBe(boom);
  });
});

describe("HeartbeatPump", () => {
  it("no-ops after stop and still reports a missing head while live", async () => {
    const keyring = new SingleKeyKeyring(SOUL.privateKey);
    const signer = keyring.deriveSessionKey(DOOR_ID, 1);
    const clock: Clock = { now: () => AT };
    const stages: string[] = [];
    const door: DoorConnection = {
      async heartbeat() {
        throw new Error("should not ping");
      },
      async attest() {
        throw new Error("should not attest");
      }
    };
    const deps: HeartbeatPumpDeps = {
      store: new MemorySoulStore(),
      door,
      clock,
      sessionSigner: signer,
      keyring,
      doorId: DOOR_ID,
      epoch: 1,
      residency: RESIDENCY,
      sessionPublicKey: signer.publicKey,
      notifyHeartbeatError(_error, stage) {
        stages.push(stage);
      }
    };
    const pump = new HeartbeatPump(deps);
    await expect(pump.run("departing")).resolves.toBeUndefined();
    await expect(pump.run("live")).rejects.toThrow("heartbeat: store has no head");
    expect(stages).toEqual([]);
  });
});
