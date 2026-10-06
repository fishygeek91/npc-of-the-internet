import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { Room } from "../src/room.js";
import { VisitorSite, type RelayRequest, type VisitorSiteOptions } from "../src/site.js";
import { postJson, silentLogger, SseReader } from "./helpers.js";

type Harness = { site: VisitorSite; url: string; relayed: RelayRequest[]; room: Room };

describe("VisitorSite", () => {
  const sites: VisitorSite[] = [];
  const readers: SseReader[] = [];

  afterEach(async () => {
    for (const reader of readers.splice(0)) {
      reader.close();
    }
    for (const site of sites.splice(0)) {
      await site.stop();
    }
  });

  async function start(overrides: Partial<VisitorSiteOptions> = {}): Promise<Harness> {
    const relayed: RelayRequest[] = [];
    const room = new Room();
    const site = new VisitorSite({
      door: { id: "web:test", name: "Test porch", description: "For tests." },
      room,
      isPresent: () => true,
      lastSeenHere: () => null,
      relay: (relay) => {
        relayed.push(relay);
        return true;
      },
      maxClients: 10,
      globalPerMinute: 30,
      trustProxy: false,
      clock: { nowMs: () => Date.now() },
      logger: silentLogger,
      ...overrides
    });
    sites.push(site);
    const bound = await site.start("127.0.0.1", 0);
    return { site, url: bound.url, relayed, room };
  }

  it("serves the page and assets with strict security headers", async () => {
    const { url } = await start();
    for (const [path, type] of [
      ["/", "text/html"],
      ["/app.js", "text/javascript"],
      ["/app.css", "text/css"]
    ] as const) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(type);
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
          "script-src 'self'; frame-ancestors 'none'; base-uri 'none'"
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect((await fetch(`${url}/`, { method: "DELETE" })).status).toBe(405);
  });

  it("never renders room text with innerHTML in the browser client", async () => {
    const { url } = await start();
    const script = await (await fetch(`${url}/app.js`)).text();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  });

  it("answers 409 not_here when the Wanderer is absent", async () => {
    const { url, relayed } = await start({
      isPresent: () => false,
      lastSeenHere: () => "2026-10-06T09:00:00.000Z"
    });
    const result = await postJson(`${url}/api/say`, { name: "Ada", text: "hello" });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "not_here" } });
    expect(relayed).toHaveLength(0);
    const state = (await (await fetch(`${url}/api/state`)).json()) as Record<string, unknown>;
    expect(state).toMatchObject({
      present: false,
      door: { id: "web:test" },
      wanderer: { last_seen_here: "2026-10-06T09:00:00.000Z" },
      messages: []
    });
  });

  it("includes atlas whereabouts while absent and tolerates their absence", async () => {
    const { url } = await start({
      isPresent: () => false,
      whereabouts: () =>
        Promise.resolve({ status: "present", door_id: "discord:1", since: "2026-10-06T08:00:00Z" })
    });
    const state = (await (await fetch(`${url}/api/state`)).json()) as Record<string, unknown>;
    expect(state.wanderer).toEqual({
      last_seen_here: null,
      status: "present",
      door_id: "discord:1",
      since: "2026-10-06T08:00:00Z"
    });
  });

  it("accepts a visitor message with 202 and relays it", async () => {
    const { url, relayed, room } = await start();
    const result = await postJson(`${url}/api/say`, { name: " Ada ", text: "hey wanderer" });
    expect(result.status).toBe(202);
    expect(relayed).toEqual([
      {
        msgId: result.body.id,
        authorId: expect.stringMatching(/^web-[0-9a-f]{12}$/u) as unknown,
        name: "Ada",
        text: "hey wanderer",
        addressed: true
      }
    ]);
    expect(room.recent(10)).toMatchObject([{ id: result.body.id, from: "visitor", name: "Ada" }]);
  });

  it("answers 409 when the session ends between check and relay", async () => {
    const { url, room } = await start({
      relay: () => {
        throw new Error("session_invalid");
      }
    });
    const result = await postJson(`${url}/api/say`, { name: "Ada", text: "hi" });
    expect(result.status).toBe(409);
    expect(room.recent(10)).toHaveLength(0);
  });

  it("validates input, content type, size and cross-site posts", async () => {
    const { url, relayed } = await start();
    expect((await postJson(`${url}/api/say`, { name: "", text: "hi" })).body).toMatchObject({
      error: { code: "invalid_name" }
    });
    expect((await postJson(`${url}/api/say`, { name: "Ada", text: "" })).status).toBe(400);
    const notJson = await fetch(`${url}/api/say`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ name: "Ada", text: "hi" })
    });
    expect(notJson.status).toBe(415);
    const broken = await fetch(`${url}/api/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope"
    });
    expect(broken.status).toBe(400);
    const huge = await postJson(`${url}/api/say`, { name: "Ada", text: "x".repeat(5000) });
    expect(huge.status).toBe(413);
    expect(await postChunked(url, "x".repeat(6000))).toBe(413);
    const crossSite = await postJson(
      `${url}/api/say`,
      { name: "Ada", text: "hi" },
      { "Sec-Fetch-Site": "cross-site" }
    );
    expect(crossSite.status).toBe(403);
    expect(relayed).toHaveLength(0);
  });

  it("rate limits a visitor politely (429 + Retry-After)", async () => {
    const { url } = await start();
    expect((await postJson(`${url}/api/say`, { name: "Ada", text: "one" })).status).toBe(202);
    const response = await fetch(`${url}/api/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", text: "two" })
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toMatchObject({
      error: { code: "rate_limited" },
      retry_after_s: 3
    });
  });

  it("rate limits by the last X-Forwarded-For hop only when the proxy is trusted", async () => {
    const trusted = await start({ trustProxy: true });
    const say = (harness: Harness, xff: string) =>
      postJson(`${harness.url}/api/say`, { name: "Ada", text: "hi" }, { "X-Forwarded-For": xff });
    expect((await say(trusted, "6.6.6.6, 203.0.113.1")).status).toBe(202);
    // Spoofed leading hops do not buy a fresh budget.
    expect((await say(trusted, "7.7.7.7, 203.0.113.1")).status).toBe(429);
    expect((await say(trusted, "6.6.6.6, 203.0.113.2")).status).toBe(202);

    const untrusted = await start({ trustProxy: false });
    expect((await say(untrusted, "203.0.113.1")).status).toBe(202);
    expect((await say(untrusted, "203.0.113.2")).status).toBe(429);
  });

  it("streams room events and presence over SSE, capped at maxClients", async () => {
    const { url, site, room } = await start({ maxClients: 2 });
    const first = await SseReader.open(`${url}/api/events`);
    readers.push(first);
    expect(await first.next("presence")).toEqual({ present: true, last_seen_here: null });
    const second = await SseReader.open(`${url}/api/events`);
    readers.push(second);
    const third = await SseReader.open(`${url}/api/events`);
    readers.push(third);
    expect([first.status, second.status, third.status]).toEqual([200, 200, 503]);
    expect(site.clientCount()).toBe(2);

    room.append({ id: "m1", at: "t", from: "wanderer", name: "The Wanderer", text: "<b>hi</b>" });
    expect(await first.next("message")).toMatchObject({ id: "m1", text: "<b>hi</b>" });
    room.react("m1", "✨");
    expect(await second.next("reaction")).toEqual({ target: "m1", emoji: "✨" });
    site.broadcastPresence(false);
    expect(
      await second.next("presence", (data) => (data as { present: boolean }).present === false)
    ).toBeTruthy();

    first.close();
    await waitFor(() => site.clientCount() === 1);
  });
});

/** POST a body with chunked transfer encoding (no Content-Length) and return the status. */
function postChunked(url: string, text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${url}/api/say`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.write(`{"name":"Ada","text":"`);
    req.write(text);
    req.end(`"}`);
  });
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
