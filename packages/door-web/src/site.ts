import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "pino";

import type { WandererWhereabouts } from "./atlas.js";
import type { Room, RoomEvent, RoomMessage } from "./room.js";
import { DailyBudget, VisitorRateLimiter, type MsClock } from "./rate-limit.js";
import { clientIp, clientKey, isAddressed, parseSay, VisitorIds } from "./visitor.js";

/** Max `POST /api/say` body (bytes). */
export const SAY_BODY_MAX_BYTES = 4096;
/** Messages returned by `GET /api/state`. */
export const STATE_MESSAGES = 100;
/** SSE heartbeat comment interval. */
export const SSE_HEARTBEAT_MS = 25_000;
/** Concurrent SSE streams one client address may hold. */
export const SSE_MAX_PER_IP = 20;
/** Unsent SSE bytes after which a slow reader is dropped. */
export const SSE_MAX_BUFFERED_BYTES = 64 * 1024;
/** Hard deadline for receiving a whole `POST /api/say` body (slow-body guard). */
export const SAY_BODY_TIMEOUT_MS = 5_000;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
    "script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin"
};

type StaticAsset = { body: Buffer; type: string };

/** Load the browser assets shipped in `public/` (read once at startup). */
function loadAssets(): Map<string, StaticAsset> {
  const read = (name: string): Buffer =>
    readFileSync(new URL(`../public/${name}`, import.meta.url));
  return new Map<string, StaticAsset>([
    ["/", { body: read("index.html"), type: "text/html; charset=utf-8" }],
    ["/app.js", { body: read("app.js"), type: "text/javascript; charset=utf-8" }],
    ["/app.css", { body: read("app.css"), type: "text/css; charset=utf-8" }]
  ]);
}

/** Public description of this Door shown on the page. */
export type DoorInfo = { id: string; name: string; description: string };

/** A visitor message on its way to the Wanderer. */
export type RelayRequest = {
  msgId: string;
  authorId: string;
  name: string;
  text: string;
  addressed: boolean;
};

/** What the visitor site needs from its host (the Door wiring in `start.ts`). */
export type VisitorSiteOptions = {
  door: DoorInfo;
  room: Room;
  /** True while the Wanderer resides here and its runtime is connected. */
  isPresent: () => boolean;
  /** When the Wanderer was last present here (ISO), if ever since boot. */
  lastSeenHere: () => string | null;
  /** Where the Wanderer is now (atlas), when configured. */
  whereabouts?: () => Promise<WandererWhereabouts | null>;
  /** Deliver a visitor message to the Wanderer; return false when it is not here. */
  relay: (request: RelayRequest) => boolean;
  maxClients: number;
  globalPerMinute: number;
  /** Visitor messages relayed to the Wanderer per UTC day; beyond it `429 quiet_hours`. */
  dailyMax: number;
  /** Override {@link SAY_BODY_TIMEOUT_MS} (tests). */
  bodyTimeoutMs?: number;
  trustProxy: boolean;
  clock: MsClock;
  logger: Logger;
};

/** One open SSE stream; `key` is the client's {@link clientKey} (IPv6 /64). */
type SseClient = { res: ServerResponse; key: string };

/**
 * The public visitor site: static page, `GET /api/state`, `GET /api/events` (SSE),
 * `POST /api/say`, `GET /healthz`. Plain `node:http`, no framework.
 */
export class VisitorSite {
  private readonly options: VisitorSiteOptions;
  private readonly assets = loadAssets();
  private readonly limiter: VisitorRateLimiter;
  private readonly daily: DailyBudget;
  private readonly ids: VisitorIds;
  private readonly clients = new Set<SseClient>();
  private server: Server | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: VisitorSiteOptions) {
    this.options = options;
    this.limiter = new VisitorRateLimiter({
      globalPerMinute: options.globalPerMinute,
      clock: options.clock
    });
    this.daily = new DailyBudget(options.dailyMax, options.clock);
    this.ids = new VisitorIds(options.clock);
  }

  /** Start listening; resolves with the bound address. */
  start(host: string, port: number): Promise<{ host: string; port: number; url: string }> {
    const server = createServer((req, res) => {
      try {
        this.route(req, res);
      } catch {
        this.fail(res, 500, "internal_error", "something went wrong");
      }
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxHeadersCount = 64;
    server.maxConnections = this.options.maxClients + 256;
    this.server = server;
    this.unsubscribe = this.options.room.subscribe((event) => {
      this.fanOut(event);
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        this.write(client, ": ping\n\n");
      }
    }, SSE_HEARTBEAT_MS);
    this.heartbeat.unref();

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("visitor site failed to resolve listen address"));
          return;
        }
        const boundHost =
          address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
        resolve({
          host: boundHost,
          port: address.port,
          url: `http://${boundHost}:${String(address.port)}`
        });
      });
    });
  }

  /** Close SSE streams and the listener. */
  async stop(): Promise<void> {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients) {
      client.res.end();
    }
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server === null) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /** Number of open SSE streams. */
  clientCount(): number {
    return this.clients.size;
  }

  /** Tell every open stream whether the Wanderer is here. */
  broadcastPresence(present: boolean): void {
    const payload = sseFrame("presence", { present, last_seen_here: this.options.lastSeenHere() });
    for (const client of this.clients) {
      this.write(client, payload);
    }
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const method = req.method ?? "GET";
    const isRead = method === "GET" || method === "HEAD";

    if (path === "/api/say") {
      if (method !== "POST") {
        this.methodNotAllowed(res, "POST");
        return;
      }
      void this.handleSay(req, res).catch(() => {
        this.fail(res, 500, "internal_error", "something went wrong");
      });
      return;
    }
    if (!isRead) {
      this.methodNotAllowed(res, "GET, HEAD");
      return;
    }
    if (path === "/healthz") {
      this.send(res, 200, "text/plain; charset=utf-8", "ok", "no-store");
      return;
    }
    if (path === "/api/state") {
      void this.handleState(res).catch(() => {
        this.fail(res, 500, "internal_error", "something went wrong");
      });
      return;
    }
    if (path === "/api/events") {
      if (method !== "GET") {
        // Only GET holds a stream open; HEAD would take a slot for nothing.
        this.methodNotAllowed(res, "GET");
        return;
      }
      this.handleEvents(req, res);
      return;
    }
    const asset = this.assets.get(path);
    if (asset !== undefined) {
      this.send(res, 200, asset.type, method === "HEAD" ? "" : asset.body, "no-cache");
      return;
    }
    this.fail(res, 404, "not_found", "not found");
  }

  private async handleState(res: ServerResponse): Promise<void> {
    const present = this.options.isPresent();
    const body: {
      present: boolean;
      door: DoorInfo;
      wanderer?: Partial<WandererWhereabouts> & { last_seen_here: string | null };
      messages: RoomMessage[];
    } = {
      present,
      door: this.options.door,
      messages: this.options.room.recent(STATE_MESSAGES)
    };
    if (!present) {
      const where = (await this.options.whereabouts?.()) ?? null;
      body.wanderer = { last_seen_here: this.options.lastSeenHere(), ...(where ?? {}) };
    }
    this.json(res, 200, body);
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= this.options.maxClients) {
      this.fail(res, 503, "too_many_listeners", "the porch is full; try again soon");
      return;
    }
    const key = clientKey(clientIp(req, this.options.trustProxy));
    let fromKey = 0;
    for (const client of this.clients) {
      if (client.key === key) {
        fromKey += 1;
      }
    }
    if (fromKey >= SSE_MAX_PER_IP) {
      this.fail(res, 429, "too_many_listeners", "too many open tabs from your address");
      return;
    }

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const client: SseClient = { res, key };
    this.clients.add(client);
    const drop = (): void => {
      this.clients.delete(client);
    };
    res.on("close", drop);
    res.on("error", drop);
    this.write(
      client,
      sseFrame("presence", {
        present: this.options.isPresent(),
        last_seen_here: this.options.lastSeenHere()
      })
    );
  }

  private async handleSay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
      this.fail(res, 403, "forbidden", "cross-site posts are not accepted");
      return;
    }
    const contentType = req.headers["content-type"] ?? "";
    if (!/^application\/json\b/iu.test(contentType)) {
      this.fail(res, 415, "unsupported_media_type", "send JSON");
      return;
    }
    const read = await readBody(
      req,
      SAY_BODY_MAX_BYTES,
      this.options.bodyTimeoutMs ?? SAY_BODY_TIMEOUT_MS
    );
    if (!read.ok) {
      res.setHeader("Connection", "close");
      if (read.reason === "timeout") {
        // The client stalled mid-body: answer, then drop the connection outright.
        res.once("finish", () => req.socket.destroy());
        this.fail(res, 408, "request_timeout", "the message took too long to arrive");
      } else {
        this.fail(res, 413, "too_large", "message too large");
      }
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(read.text) as unknown;
    } catch {
      this.fail(res, 400, "invalid_json", "body must be JSON");
      return;
    }
    const parsed = parseSay(body);
    if (!parsed.ok) {
      this.fail(res, 400, parsed.code, parsed.message);
      return;
    }
    if (!this.options.isPresent()) {
      this.fail(res, 409, "not_here", "the Wanderer is elsewhere right now");
      return;
    }
    const today = this.daily.check();
    if (!today.ok) {
      const seconds = Math.ceil(today.retryAfterMs / 1000);
      res.setHeader("Retry-After", String(seconds));
      this.json(res, 429, {
        error: {
          code: "quiet_hours",
          message:
            "the Wanderer has listened to a lot today and is resting until midnight UTC — " +
            "come back then"
        },
        retry_after_s: seconds
      });
      return;
    }
    const key = clientKey(clientIp(req, this.options.trustProxy));
    const decision = this.limiter.take(key);
    if (!decision.ok) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      res.setHeader("Retry-After", String(seconds));
      this.json(res, 429, {
        error: { code: "rate_limited", message: "a little slower, please" },
        retry_after_s: seconds
      });
      this.options.logger.debug({ retryAfterS: seconds }, "say_rate_limited");
      return;
    }

    const msgId = `web-${randomBytes(8).toString("hex")}`;
    const { name, text } = parsed.value;
    let delivered: boolean;
    try {
      delivered = this.options.relay({
        msgId,
        authorId: this.ids.idFor(key),
        name,
        text,
        addressed: isAddressed(text)
      });
    } catch {
      delivered = false;
    }
    if (!delivered) {
      this.fail(res, 409, "not_here", "the Wanderer is elsewhere right now");
      return;
    }
    this.daily.record();
    this.options.room.append({
      id: msgId,
      at: new Date(this.options.clock.nowMs()).toISOString(),
      from: "visitor",
      name,
      text
    });
    this.json(res, 202, { id: msgId });
  }

  private fanOut(event: RoomEvent): void {
    const payload =
      event.type === "message"
        ? sseFrame("message", event.message)
        : sseFrame("reaction", { target: event.target, emoji: event.emoji });
    for (const client of this.clients) {
      this.write(client, payload);
    }
  }

  /** Write to one stream; drop readers that stop reading (bounded buffering). */
  private write(client: SseClient, payload: string): void {
    if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      this.clients.delete(client);
      client.res.destroy();
      return;
    }
    client.res.write(payload);
  }

  private methodNotAllowed(res: ServerResponse, allow: string): void {
    res.setHeader("Allow", allow);
    this.fail(res, 405, "method_not_allowed", "method not allowed");
  }

  private fail(res: ServerResponse, status: number, code: string, message: string): void {
    this.json(res, status, { error: { code, message } });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    this.send(res, status, "application/json; charset=utf-8", JSON.stringify(body), "no-store");
  }

  private send(
    res: ServerResponse,
    status: number,
    type: string,
    body: string | Buffer,
    cache: string
  ): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": type,
      "Cache-Control": cache
    });
    res.end(body);
  }
}

/** Serialize one SSE event (JSON keeps `data` on a single line). */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Outcome of {@link readBody}. */
type BodyResult = { ok: true; text: string } | { ok: false; reason: "too_large" | "timeout" };

/**
 * Read a request body of at most `limit` bytes that must arrive completely within
 * `timeoutMs` (a hard deadline for the whole body, not an idle timeout, so a trickling
 * client cannot hold the connection open).
 */
function readBody(req: IncomingMessage, limit: number, timeoutMs: number): Promise<BodyResult> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.resolve({ ok: false, reason: "too_large" });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyResult): void => {
      done = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const deadline = setTimeout(() => {
      if (!done) {
        finish({ ok: false, reason: "timeout" });
      }
    }, timeoutMs);
    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
      }
    });
    req.on("error", (error) => {
      if (!done) {
        done = true;
        clearTimeout(deadline);
        reject(error);
      }
    });
  });
}
