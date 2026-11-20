import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  CHAIN_EXPORT_TAIL_CACHE_ENTRIES,
  CHAIN_EXPORT_TAIL_LOADS
} from "../src/chain-export-proxy.js";
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

  it("rejects an after that is not a CID and does not fetch Atlas", async () => {
    let calls = 0;
    const atlasFetch: typeof fetch = function (this: void) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const atlas = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200);
      res.end("{}");
    });
    closers.push(atlas.close);
    const site = await openSite(sites, atlas.url, { atlasFetch });
    const cid = fakeCid(1);
    const queries = [
      "after=nope",
      `after=${cid.toUpperCase()}`,
      `after=%20${cid}`,
      `after=${cid}%20`,
      "after=",
      `after=${cid}&after=${fakeCid(2)}`,
      "after=../secret",
      "after=%"
    ];
    for (const query of queries) {
      const response = await fetch(`${site}/chain/export?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: "after must be a CID" }
      });
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-expose-headers")).toBe("ETag");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it("caches each after, forwards a valid CID, and passes export_after_unknown through", async () => {
    const calls = new Map<string, number>();
    const atlasFetch: typeof fetch = function (this: void, input: RequestInfo | URL) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      const url = String(input);
      const cursor = new URL(url).searchParams.get("after") ?? "full";
      calls.set(cursor, (calls.get(cursor) ?? 0) + 1);
      if (cursor === fakeCid(9)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "export_after_unknown",
                message: "after is not a record on this chain"
              }
            }),
            { status: 404, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ cursor }), {
          status: 200,
          headers: { etag: `"${cursor}"`, "cache-control": "no-cache" }
        })
      );
    };
    let now = 1_000;
    const atlas = await listen((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    closers.push(atlas.close);
    const site = await openSite(sites, atlas.url, {
      atlasFetch,
      exportNow: () => now,
      exportCacheTtlMs: 5_000
    });
    const cid = fakeCid(4);
    const forwarded = await fetch(`${site}/chain/export?after=${cid}&unused=1`);
    expect(forwarded.status).toBe(200);
    expect(calls.get(cid)).toBe(1);
    expect(await forwarded.json()).toEqual({ cursor: cid });
    const repeat = await fetch(`${site}/chain/export?after=${cid}`);
    expect(repeat.status).toBe(200);
    expect(calls.get(cid)).toBe(1);
    const full = await fetch(`${site}/chain/export`);
    expect(full.status).toBe(200);
    expect(calls.get("full")).toBe(1);
    const again = await fetch(`${site}/chain/export`);
    expect(again.status).toBe(200);
    expect(calls.get("full")).toBe(1);
    for (let index = 0; index < CHAIN_EXPORT_TAIL_CACHE_ENTRIES + 1; index += 1) {
      const response = await fetch(`${site}/chain/export?after=${fakeCid(20 + index)}`);
      expect(response.status).toBe(200);
    }
    const oldest = fakeCid(20);
    const newest = fakeCid(20 + CHAIN_EXPORT_TAIL_CACHE_ENTRIES);
    expect(calls.get(oldest)).toBe(1);
    expect(calls.get(newest)).toBe(1);
    const kept = await fetch(`${site}/chain/export?after=${newest}`, {
      headers: { "if-none-match": `"${oldest}"` }
    });
    expect(kept.status).toBe(200);
    expect(calls.get(newest)).toBe(1);
    const freshOldest = await fetch(`${site}/chain/export?after=${oldest}`);
    expect(freshOldest.status).toBe(200);
    expect(calls.get(oldest)).toBe(2);
    expect(calls.get("full")).toBe(1);
    now += 10_000;
    const unknown = fakeCid(9);
    const missing = await fetch(`${site}/chain/export?after=${unknown}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "export_after_unknown", message: "after is not a record on this chain" }
    });
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    expect(missing.headers.get("access-control-expose-headers")).toBe("ETag");
    const missingAgain = await fetch(`${site}/chain/export?after=${unknown}`);
    expect(missingAgain.status).toBe(404);
    expect(calls.get(unknown)).toBe(2);
  });

  it("applies the byte cap to a tail and keeps CORS", async () => {
    const seen: string[] = [];
    const fat = await listen((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records: ["x".repeat(80)] }));
    });
    closers.push(fat.close);
    const site = await openSite(sites, fat.url, { exportMaxBytes: 32 });
    const cid = fakeCid(3);
    const over = await fetch(`${site}/chain/export?after=${cid}`);
    expect(over.status).toBe(502);
    expect(await over.json()).toEqual({
      error: { code: "payload_too_large", message: "atlas export is too large" }
    });
    expect(over.headers.get("access-control-allow-origin")).toBe("*");
    expect(over.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(over.headers.get("access-control-allow-credentials")).toBeNull();
    expect(seen).toEqual([`/chain/export?after=${cid}`]);
  });

  it("caps concurrent tail loads and drops tail bytes when the lifetime ends", async () => {
    const payload = `{"ok":true,"pad":"${"x".repeat(64)}"}`;
    const bodyBytes = Buffer.byteLength(payload);
    const releases = new Map<string, () => void>();
    let inflight = 0;
    let maxInflight = 0;
    let hold = true;
    const calls: string[] = [];
    const atlasFetch: typeof fetch = function (this: void, input: RequestInfo | URL) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      const after = new URL(String(input)).searchParams.get("after");
      if (after === null) {
        throw new Error("expected a tail");
      }
      calls.push(after);
      inflight += 1;
      if (inflight > maxInflight) {
        maxInflight = inflight;
      }
      const finish = (): Response => {
        inflight -= 1;
        return new Response(payload, {
          status: 200,
          headers: { etag: '"tail"', "cache-control": "no-cache" }
        });
      };
      if (!hold) {
        return Promise.resolve(finish());
      }
      return new Promise((resolve) => {
        releases.set(after, () => {
          resolve(finish());
        });
      });
    };
    let now = 0;
    const siteUrl = await openSite(sites, "http://atlas.example", {
      atlasFetch,
      exportNow: () => now,
      exportCacheTtlMs: 5_000,
      exportTailCacheBytes: bodyBytes
    });
    const porch = sites[sites.length - 1];
    if (porch === undefined) {
      throw new Error("missing porch");
    }
    const cursors = Array.from({ length: 20 }, (_unused, index) => fakeCid(index + 1));
    let busy = 0;
    let markBusy: () => void = () => undefined;
    const busyEnough = new Promise<void>((resolve) => {
      markBusy = resolve;
    });
    const pending = cursors.map(async (cid) => {
      const response = await fetch(`${siteUrl}/chain/export?after=${cid}`);
      if (response.status === 503) {
        expect(response.headers.get("retry-after")).toBe("1");
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-expose-headers")).toBe("ETag");
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        expect(await response.json()).toEqual({
          error: { code: "atlas_busy", message: "chain export is busy" }
        });
        busy += 1;
        if (busy === cursors.length - CHAIN_EXPORT_TAIL_LOADS) {
          markBusy();
        }
        return "busy" as const;
      }
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      return "ok" as const;
    });
    await busyEnough;
    expect(maxInflight).toBe(CHAIN_EXPORT_TAIL_LOADS);
    expect(inflight).toBe(CHAIN_EXPORT_TAIL_LOADS);
    expect(calls).toHaveLength(CHAIN_EXPORT_TAIL_LOADS);
    for (const release of releases.values()) {
      release();
    }
    const outcomes = await Promise.all(pending);
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(CHAIN_EXPORT_TAIL_LOADS);
    expect(outcomes.filter((outcome) => outcome === "busy")).toHaveLength(
      cursors.length - CHAIN_EXPORT_TAIL_LOADS
    );
    expect(porch.tailCacheBytes()).toBe(bodyBytes);
    const older = calls[0];
    if (older === undefined) {
      throw new Error("missing older tail");
    }
    now = 5_000;
    expect(porch.tailCacheBytes()).toBe(0);
    expect(calls).toHaveLength(CHAIN_EXPORT_TAIL_LOADS);
    hold = false;
    const refreshed = await fetch(`${siteUrl}/chain/export?after=${older}`);
    expect(refreshed.status).toBe(200);
    expect(calls.filter((cursor) => cursor === older)).toHaveLength(2);
    expect(porch.tailCacheBytes()).toBeLessThanOrEqual(bodyBytes);
    expect(maxInflight).toBeLessThanOrEqual(CHAIN_EXPORT_TAIL_LOADS);
  });
});

const CID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function fakeCid(n: number): string {
  let rest = "";
  let value = n;
  for (let index = 0; index < 57; index += 1) {
    rest = `${CID_ALPHABET.charAt(value % 32)}${rest}`;
    value = Math.floor(value / 32);
  }
  return `bagu${rest}`;
}

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
