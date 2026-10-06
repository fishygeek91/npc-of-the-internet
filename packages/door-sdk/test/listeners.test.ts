import { generateKeypair } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import type { SessionLifecycleEvent } from "../src/door.js";
import type { OutboundFrame } from "../src/schemas.js";
import {
  arrive,
  createHarness,
  departureRequest,
  DOOR_ID,
  EPOCH,
  outboundFrame
} from "./helpers/door-harness.js";

describe("session lifecycle listeners", () => {
  it("emit arrived, superseded and retired to every subscriber", async () => {
    const h = createHarness();
    const first: SessionLifecycleEvent[] = [];
    const second: SessionLifecycleEvent[] = [];
    h.door.addSessionLifecycleListener((event) => first.push(event));
    h.door.addSessionLifecycleListener((event) => second.push(event));

    await arrive(h);
    const next = generateKeypair();
    await arrive(h, EPOCH + 1, next);
    await h.door.attest(departureRequest({ ...h, session: next }, EPOCH + 1));

    const expected: SessionLifecycleEvent[] = [
      { type: "arrived", doorId: DOOR_ID, epoch: EPOCH },
      { type: "superseded", doorId: DOOR_ID, epoch: EPOCH },
      { type: "arrived", doorId: DOOR_ID, epoch: EPOCH + 1 },
      { type: "retired", doorId: DOOR_ID, epoch: EPOCH + 1 }
    ];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });

  it("see the new state when called (no active session on retired; new epoch on arrived)", async () => {
    const h = createHarness();
    const seen: Array<[string, number | null]> = [];
    h.door.addSessionLifecycleListener((event) => {
      seen.push([event.type, h.door.getActiveEpoch()]);
    });
    await arrive(h);
    await h.door.attest(departureRequest(h));
    expect(seen).toEqual([
      ["arrived", EPOCH],
      ["retired", null]
    ]);
  });

  it("a throwing listener is isolated: others still run and the attest succeeds", async () => {
    const h = createHarness();
    const after: string[] = [];
    h.door.addSessionLifecycleListener(() => {
      throw new Error("adapter bug");
    });
    h.door.addSessionLifecycleListener((event) => after.push(event.type));

    await expect(arrive(h)).resolves.toBeUndefined();
    await expect(h.door.attest(departureRequest(h))).resolves.toMatchObject({
      kind: "departure"
    });
    expect(after).toEqual(["arrived", "retired"]);
    expect(h.door.getActiveEpoch()).toBeNull();
  });

  it("unsubscribe stops delivery (and only for that listener)", async () => {
    const h = createHarness();
    const kept: string[] = [];
    const dropped: string[] = [];
    h.door.addSessionLifecycleListener((event) => kept.push(event.type));
    const off = h.door.addSessionLifecycleListener((event) => dropped.push(event.type));
    await arrive(h);
    off();
    off();
    await h.door.attest(departureRequest(h));
    expect(kept).toEqual(["arrived", "retired"]);
    expect(dropped).toEqual(["arrived"]);
  });

  it("a rejected arrival emits nothing", async () => {
    const h = createHarness({
      policy: {
        acceptArrival: () => {
          throw new Error("closed tonight");
        }
      }
    });
    const events: string[] = [];
    h.door.addSessionLifecycleListener((event) => events.push(event.type));
    await expect(arrive(h)).rejects.toMatchObject({ code: "not_hosting" });
    expect(events).toEqual([]);
  });
});

describe("outbound listeners", () => {
  it("are called once per accepted frame, after verification", async () => {
    const h = createHarness();
    await arrive(h);
    const first: OutboundFrame[] = [];
    const second: string[] = [];
    h.door.addOutboundListener((frame) => first.push(frame));
    h.door.addOutboundListener((frame) => second.push(frame.msg_id));

    const hello = outboundFrame(h, "out_1", { text: "Hello, Lantern." });
    const react = outboundFrame(h, "out_2", { reaction: { emoji: "🦉", target_msg_id: "in_9" } });
    h.door.handleOutbound(hello);
    h.door.handleOutbound(react);

    expect(first).toEqual([hello, react]);
    expect(second).toEqual(["out_1", "out_2"]);
  });

  it("are not called for replays, bad signatures, wrong epochs, stale frames or no session", async () => {
    const h = createHarness();
    const delivered: string[] = [];
    h.door.addOutboundListener((frame) => delivered.push(frame.msg_id));

    expect(() => h.door.handleOutbound(outboundFrame(h, "early", { text: "x" }))).toThrow(
      /no active session/
    );

    await arrive(h);
    const frame = outboundFrame(h, "out_1", { text: "once" });
    h.door.handleOutbound(frame);
    expect(() => h.door.handleOutbound(frame)).toThrow(/msg_replay/);
    expect(() =>
      h.door.handleOutbound(
        outboundFrame(h, "forged", { text: "x" }, { session: generateKeypair() })
      )
    ).toThrow(/signature_invalid/);
    expect(() => h.door.handleOutbound(outboundFrame(h, "tampered", { text: "x" }))).not.toThrow();
    const tampered = outboundFrame(h, "tampered_2", { text: "original" });
    expect(() => h.door.handleOutbound({ ...tampered, body: { text: "changed" } })).toThrow(
      /signature_invalid/
    );
    expect(() =>
      h.door.handleOutbound(outboundFrame(h, "wrong_epoch", { text: "x" }, { epoch: EPOCH + 1 }))
    ).toThrow(/epoch mismatch/);
    expect(() =>
      h.door.handleOutbound(
        outboundFrame(h, "stale", { text: "x" }, { issuedAt: "2026-10-06T10:00:00.000Z" })
      )
    ).toThrow(/timestamp_stale/);

    expect(delivered).toEqual(["out_1", "tampered"]);
  });

  it("a throwing listener is isolated: the frame is still accepted and recorded", async () => {
    const h = createHarness();
    await arrive(h);
    const after: string[] = [];
    h.door.addOutboundListener(() => {
      throw new Error("platform send failed");
    });
    h.door.addOutboundListener((frame) => after.push(frame.msg_id));

    const frame = outboundFrame(h, "out_1", { text: "still here" });
    expect(() => h.door.handleOutbound(frame)).not.toThrow();
    expect(after).toEqual(["out_1"]);
    expect(h.door.residencyRecordSize()).toBe(1);
    // Accepted means accepted: a retry is a replay, not a second delivery.
    expect(() => h.door.handleOutbound(frame)).toThrow(/msg_replay/);
    expect(after).toEqual(["out_1"]);
  });

  it("unsubscribe stops delivery", async () => {
    const h = createHarness();
    await arrive(h);
    const delivered: string[] = [];
    const off = h.door.addOutboundListener((frame) => delivered.push(frame.msg_id));
    h.door.handleOutbound(outboundFrame(h, "out_1", { text: "a" }));
    off();
    h.door.handleOutbound(outboundFrame(h, "out_2", { text: "b" }));
    expect(delivered).toEqual(["out_1"]);
  });

  it("msg_id replay memory resets with each new residency", async () => {
    const h = createHarness();
    const delivered: string[] = [];
    h.door.addOutboundListener((frame) => delivered.push(`${String(frame.epoch)}:${frame.msg_id}`));
    await arrive(h);
    h.door.handleOutbound(outboundFrame(h, "out_1", { text: "a" }));
    await h.door.attest(departureRequest(h));
    await arrive(h, EPOCH + 1);
    h.door.handleOutbound(outboundFrame(h, "out_1", { text: "a" }, { epoch: EPOCH + 1 }));
    expect(delivered).toEqual([`${String(EPOCH)}:out_1`, `${String(EPOCH + 1)}:out_1`]);
  });
});
