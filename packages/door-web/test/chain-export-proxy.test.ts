import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { Room } from "../src/room.js";
import { VisitorSite, type VisitorSiteOptions } from "../src/site.js";
import { silentLogger } from "./helpers.js";

describe("GET /chain/export proxy", () => {
  const sites: VisitorSite[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const site of sites.splice(0)) {
      await site.stop();
    }
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  it("passes a 200 and a 304 through without forwarding client headers", async () => {
    const seen: Array<IncomingMessage["headers"]> = [];
    const etag = '"one"';
    const atlas = await listen((req, res) => {
      seen.push(req.headers);
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": "no-cache" });
        res.end();
        return;
      }
      res.writeHead(200, {
        etag,
        "cache-control": "no-cache",
        "content-type": "application/json",
        "set-cookie": "secret=1"
      });
      res.end(JSON.stringify({ records: [], doorPublicKeys: {}, blobs: {} }));
    });
    closers.push(atlas.close);
    const site = await openSite(sites, atlas.url);
    const first = await fetch(`${site}/chain/export`, {
      headers: { cookie: "session=leak", authorization: "Bearer leak" }
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe(etag);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(await first.json()).toEqual({ records: [], doorPublicKeys: {}, blobs: {} });
    const request = seen[0];
    expect(request?.["cookie"]).toBeUndefined();
    expect(request?.["authorization"]).toBeUndefined();
    expect(request?.["if-none-match"]).toBeUndefined();

    const again = await fetch(`${site}/chain/export`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
    expect(again.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(again.headers.get("access-control-allow-credentials")).toBeNull();
    expect(seen).toHaveLength(1);
    expect((await fetch(`${site}/chain/export`, { method: "POST" })).status).toBe(405);
  });

  it("shares one upstream fetch and answers If-None-Match from the short cache", async () => {
    let calls = 0;
    let release = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = JSON.stringify({ records: [], doorPublicKeys: {}, blobs: {} });
    const atlasFetch: typeof fetch = () => {
      calls += 1;
      return opened.then(
        () =>
          new Response(body, {
            status: 200,
            headers: { etag: '"shared"', "cache-control": "no-cache" }
          })
      );
    };
    let now = 0;
    const site = await openSite(sites, "http://atlas.example", {
      atlasFetch,
      exportNow: () => now,
      exportCacheTtlMs: 5_000
    });
    const pending = Array.from({ length: 8 }, () => fetch(`${site}/chain/export`));
    const deadline = Date.now() + 1_000;
    while (calls < 1 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(calls).toBe(1);
    release();
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(calls).toBe(1);

    const cached = await fetch(`${site}/chain/export`);
    expect(cached.status).toBe(200);
    expect(calls).toBe(1);
    const local = await fetch(`${site}/chain/export`, { headers: { "if-none-match": '"shared"' } });
    expect(local.status).toBe(304);
    expect(await local.text()).toBe("");
    expect(calls).toBe(1);

    now = 5_000;
    const again = await fetch(`${site}/chain/export`);
    expect(again.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("does not cache an upstream error", async () => {
    let calls = 0;
    const atlasFetch: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "chain_unreadable", message: "no" } }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
      );
    };
    const site = await openSite(sites, "http://atlas.example", { atlasFetch });
    const first = await fetch(`${site}/chain/export`);
    const second = await fetch(`${site}/chain/export`);
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(calls).toBe(2);
    expect(first.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("allows a cross-origin shrine to read only the export", async () => {
    const atlas = await listen((_req, res) => {
      res.writeHead(200, { etag: '"one"', "content-type": "application/json" });
      res.end(JSON.stringify({ records: [], doorPublicKeys: {}, blobs: {} }));
    });
    closers.push(atlas.close);
    const site = await openSite(sites, atlas.url);
    const preflight = await fetch(`${site}/chain/export`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:8090",
        "access-control-request-method": "GET",
        "access-control-request-headers": "if-none-match"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("If-None-Match");
    expect(preflight.headers.get("access-control-max-age")).toBe("600");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    const exported = await fetch(`${site}/chain/export`, {
      headers: { origin: "http://127.0.0.1:8090" }
    });
    expect(exported.headers.get("access-control-allow-origin")).toBe("*");
    expect(exported.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(exported.headers.get("access-control-allow-credentials")).toBeNull();
    const health = await fetch(`${site}/healthz`, { headers: { origin: "http://127.0.0.1:8090" } });
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never returns the server-side Atlas URL from verify-pins", async () => {
    const site = await openSite(sites, "http://atlas-api:8787");
    const response = await fetch(`${site}/api/verify-pins`);
    const pins: unknown = await response.json();
    expect(JSON.stringify(pins).includes("atlas-api")).toBe(false);
    if (typeof pins !== "object" || pins === null || !("atlasUrl" in pins)) {
      throw new Error("verify-pins omitted atlasUrl");
    }
    expect(pins.atlasUrl).toBe(new URL(site).origin);
  });

  it("maps a timeout and an oversized body to the public error shape", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined) {
          return;
        }
        const fail = (): void => {
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new DOMException("timed out", "TimeoutError"));
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      });
    const hung = await openSite(sites, "http://atlas.example", {
      exportTimeoutMs: 20,
      atlasFetch: hang
    });
    const timed = await fetch(`${hung}/chain/export`);
    expect(timed.status).toBe(504);
    expect(await timed.json()).toEqual({
      error: { code: "atlas_timeout", message: "atlas export timed out" }
    });

    const fat = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: ["x".repeat(80)] }));
    });
    closers.push(fat.close);
    const capped = await openSite(sites, fat.url, { exportMaxBytes: 32 });
    const over = await fetch(`${capped}/chain/export`);
    expect(over.status).toBe(502);
    expect(await over.json()).toEqual({
      error: { code: "payload_too_large", message: "atlas export is too large" }
    });
  });
});

async function openSite(
  sites: VisitorSite[],
  upstream: string,
  extra: Partial<VisitorSiteOptions> = {}
): Promise<string> {
  const site = new VisitorSite({
    door: { id: "web:test", name: "Test porch", description: "For tests." },
    room: new Room(),
    isPresent: () => false,
    lastSeenHere: () => null,
    relay: () => false,
    maxClients: 4,
    globalPerMinute: 10,
    dailyMax: 10,
    trustProxy: false,
    clock: { nowMs: () => Date.now() },
    logger: silentLogger,
    verifyPins: { soulPublicKey: "soul", doorPublicKey: "door", atlasUrl: null },
    atlasUpstream: upstream,
    ...extra
  });
  sites.push(site);
  const bound = await site.start("127.0.0.1", 0);
  return bound.url;
}

function listen(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(onRequest);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("atlas stub failed to bind");
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
