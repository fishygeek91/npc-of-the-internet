import { WsDoorSessionClient, type InboundFrame } from "@npc/door-sdk";
import { generateKeypair } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { startWebDoor, type WebDoorHandle } from "../src/start.js";
import {
  bindParams,
  cleanupTempDirs,
  postJson,
  signedAttest,
  signedOutbound,
  silentLogger,
  SseReader,
  testConfig
} from "./helpers.js";

const DOOR_ID = "web:test";
const EPOCH = 1;

describe("website Door end to end (real Door, HTTP/WS servers, WS session client)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    cleanupTempDirs();
  });

  async function boot(): Promise<{
    handle: WebDoorHandle;
    soul: ReturnType<typeof generateKeypair>;
  }> {
    const soul = generateKeypair();
    const handle = await startWebDoor({
      config: testConfig(soul),
      logger: silentLogger,
      env: {},
      presencePollMs: 25
    });
    cleanups.push(() => handle.stop());
    return { handle, soul };
  }

  async function connectWanderer(
    handle: WebDoorHandle,
    session: ReturnType<typeof generateKeypair>,
    inbound: InboundFrame[]
  ): Promise<WsDoorSessionClient> {
    const client = new WsDoorSessionClient({
      wsBaseUrl: handle.doorUrl.replace(/^http/u, "ws"),
      bind: bindParams(session, DOOR_ID, EPOCH),
      onInbound: (frame) => inbound.push(frame)
    });
    cleanups.push(() => client.close());
    await client.connect();
    return client;
  }

  it("relays visitors to the Wanderer and the Wanderer's words to the page", async () => {
    const { handle, soul } = await boot();
    const events = await SseReader.open(`${handle.publicUrl}/api/events`);
    cleanups.push(() => events.close());
    expect(await events.next("presence")).toMatchObject({ present: false });

    // Absent: visitors cannot speak.
    const early = await postJson(`${handle.publicUrl}/api/say`, { name: "Ada", text: "hi" });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: { code: "not_here" } });

    // A real soul-signed arrival, then the runtime binds its session socket.
    const session = generateKeypair();
    const arrival = await postJson(
      `${handle.doorUrl}/door/attest`,
      signedAttest({ kind: "arrival", doorId: DOOR_ID, epoch: EPOCH, soul, session })
    );
    expect(arrival.status).toBe(200);
    expect(await events.next("message")).toMatchObject({
      from: "system",
      text: "The Wanderer has arrived."
    });
    // Arrived but no runtime connected yet: still not present.
    expect(handle.isPresent()).toBe(false);

    const inbound: InboundFrame[] = [];
    let client = await connectWanderer(handle, session, inbound);
    expect(await events.next("presence")).toMatchObject({ present: true });

    // Visitor → Wanderer.
    const said = await postJson(`${handle.publicUrl}/api/say`, {
      name: "Ada",
      text: "@Wanderer hello there"
    });
    expect(said.status).toBe(202);
    const visitorId = said.body.id as string;
    expect(await events.next("message")).toMatchObject({
      id: visitorId,
      from: "visitor",
      name: "Ada",
      text: "@Wanderer hello there"
    });
    await waitFor(() => inbound.length === 1);
    const frame = inbound[0];
    expect(frame?.msg_id).toBe(visitorId);
    expect(frame?.body).toMatchObject({
      text: "Wanderer hello there",
      author_display: "Ada",
      addressed: true
    });
    expect(frame?.body.author_id).toMatch(/^web-[0-9a-f]{12}$/u);
    expect(JSON.stringify(frame)).not.toContain("127.0.0.1");

    // Wanderer → page: a signed reply and a reaction.
    client.sendOutbound(
      signedOutbound({
        session,
        doorId: DOOR_ID,
        epoch: EPOCH,
        msgId: "out-1",
        body: { text: "Hello, Ada. The porch light is on.", reply_to: visitorId }
      })
    );
    expect(await events.next("message", (data) => isFrom(data, "wanderer"))).toMatchObject({
      id: "w1-out-1",
      name: "The Wanderer",
      text: "Hello, Ada. The porch light is on.",
      reply_to: visitorId
    });
    client.sendOutbound(
      signedOutbound({
        session,
        doorId: DOOR_ID,
        epoch: EPOCH,
        msgId: "out-2",
        body: { reaction: { emoji: "👋", target_msg_id: visitorId } }
      })
    );
    expect(await events.next("reaction")).toEqual({ target: visitorId, emoji: "👋" });

    const state = (await (await fetch(`${handle.publicUrl}/api/state`)).json()) as {
      present: boolean;
      door: { id: string };
      messages: Array<{ id: string; reactions: string[] }>;
    };
    expect(state.present).toBe(true);
    expect(state.door.id).toBe(DOOR_ID);
    expect(state.messages.map((message) => message.id)).toContain("w1-out-1");
    expect(state.messages.find((message) => message.id === visitorId)?.reactions).toEqual(["👋"]);

    // Runtime socket drops → absent; reconnects → present again.
    await client.close();
    expect(await events.next("presence")).toMatchObject({ present: false });
    client = await connectWanderer(handle, session, inbound);
    expect(await events.next("presence")).toMatchObject({ present: true });

    // Departure (session-signed): a notice, absence, and visitors are turned away.
    const departure = await postJson(
      `${handle.doorUrl}/door/attest`,
      signedAttest({ kind: "departure", doorId: DOOR_ID, epoch: EPOCH, soul, session })
    );
    expect(departure.status).toBe(200);
    expect(await events.next("message", (data) => isFrom(data, "system"))).toMatchObject({
      text: "The Wanderer has moved on."
    });
    const gone = (await events.next("presence")) as { present: boolean; last_seen_here: string };
    expect(gone.present).toBe(false);
    expect(typeof gone.last_seen_here).toBe("string");
    const late = await postJson(`${handle.publicUrl}/api/say`, { name: "Ada", text: "wait!" });
    expect(late.status).toBe(409);
  });

  it("rejects SSE listeners beyond DOOR_WEB_MAX_CLIENTS with 503", async () => {
    const soul = generateKeypair();
    const handle = await startWebDoor({
      config: testConfig(soul, { maxClients: 2 }),
      logger: silentLogger,
      env: {}
    });
    cleanups.push(() => handle.stop());
    const first = await SseReader.open(`${handle.publicUrl}/api/events`);
    const second = await SseReader.open(`${handle.publicUrl}/api/events`);
    cleanups.push(
      () => first.close(),
      () => second.close()
    );
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await SseReader.open(`${handle.publicUrl}/api/events`);
    third.close();
    expect(third.status).toBe(503);
  });
});

function isFrom(data: unknown, from: string): boolean {
  return typeof data === "object" && data !== null && (data as { from?: unknown }).from === from;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
