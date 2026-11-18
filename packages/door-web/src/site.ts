import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "pino";

import type { WandererWhereabouts } from "./atlas.js";
import {
  ChainExportGate,
  CHAIN_EXPORT_CACHE_TTL_MS,
  ifNoneMatchSatisfied,
  proxyChainExport,
  requestOrigin,
  type ChainExportResult
} from "./chain-export-proxy.js";
import { WebDoorError } from "./errors.js";
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

/**
 * HTTP `error.code` values the porch writes itself.
 * A failed Atlas export still forwards the upstream code, which is not in this list.
 */
type PorchHttpErrorCode =
  | "atlas_unconfigured"
  | "forbidden"
  | "internal_error"
  | "invalid_json"
  | "invalid_name"
  | "invalid_text"
  | "method_not_allowed"
  | "not_found"
  | "not_here"
  | "quiet_hours"
  | "rate_limited"
  | "request_timeout"
  | "too_large"
  | "too_many_listeners"
  | "unsupported_media_type";

const SECURITY_HEADER_BASE: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin"
};

/**
 * CSP for the porch. The chain export is served from this origin, so
 * `connect-src` stays `'self'` and never names the server-side Atlas URL.
 */
export function contentSecurityPolicy(): string {
  return (
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
    "script-src 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
}

type StaticAsset = { body: Buffer; type: string; etag: string; corp?: string };

/** Load the browser assets shipped in `public/` (read once at startup). */
function loadAssets(): Map<string, StaticAsset> {
  const read = (name: string, type: string): StaticAsset => {
    const body = readFileSync(new URL(`../public/${name}`, import.meta.url));
    const digest = createHash("sha256").update(body).digest("base64url");
    return { body, type, etag: `"${digest}"` };
  };
  const shrine = read("shrine.js", "text/javascript; charset=utf-8");
  shrine.corp = "cross-origin";
  return new Map<string, StaticAsset>([
    ["/", read("index.html", "text/html; charset=utf-8")],
    ["/app.js", read("app.js", "text/javascript; charset=utf-8")],
    ["/verify.js", read("verify.js", "text/javascript; charset=utf-8")],
    ["/shrine.js", shrine],
    ["/app.css", read("app.css", "text/css; charset=utf-8")]
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
  /**
   * Public verification pins. The page uses these instead of trusting the
   * server's presence bit. The response `atlasUrl` is this porch's origin
   * when `atlasUpstream` is set, and never that upstream URL.
   */
  verifyPins: {
    soulPublicKey: string;
    doorPublicKey: string;
    atlasUrl: string | null;
  };
  /**
   * Server-side Atlas base URL (`ATLAS_API_URL`). When set, `GET /chain/export`
   * on this site forwards to it. Browsers are not given this value.
   */
  atlasUpstream?: string;
  /** Test override for the export fetch. */
  atlasFetch?: typeof fetch;
  /** Test override for {@link proxyChainExport}'s timeout. */
  exportTimeoutMs?: number;
  /** Test override for the export body cap. */
  exportMaxBytes?: number;
  /** How long a successful export is reused. Default {@link CHAIN_EXPORT_CACHE_TTL_MS}. */
  exportCacheTtlMs?: number;
  /** Clock for the export cache. Defaults to `Date.now`. */
  exportNow?: () => number;
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
  private readonly exportGate: ChainExportGate;
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
    this.exportGate = new ChainExportGate(
      () => this.loadChainExport(),
      options.exportCacheTtlMs ?? CHAIN_EXPORT_CACHE_TTL_MS,
      options.exportNow ?? Date.now
    );
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

    if (path === "/chain/export") {
      if (method === "OPTIONS") {
        this.chainExportPreflight(res);
        return;
      }
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        this.chainExportError(res, 405, "method_not_allowed", "method not allowed");
        return;
      }
      void this.handleChainExport(req, res).catch(() => {
        this.chainExportError(res, 500, "internal_error", "something went wrong");
      });
      return;
    }
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
    if (path === "/api/verify-pins") {
      this.json(res, 200, {
        soulPublicKey: this.options.verifyPins.soulPublicKey,
        doorId: this.options.door.id,
        doorPublicKey: this.options.verifyPins.doorPublicKey,
        atlasUrl: this.publicAtlasUrl(req)
      });
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
      this.sendAsset(req, res, asset, method);
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
      let where: WandererWhereabouts | null = null;
      try {
        where = (await this.options.whereabouts?.()) ?? null;
      } catch (error) {
        // An oversized Atlas body is a failed lookup, not a broken porch.
        if (!(error instanceof WebDoorError) || error.code !== "payload_too_large") {
          throw error;
        }
      }
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
      ...this.securityHeaders(),
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
          code: "quiet_hours" satisfies PorchHttpErrorCode,
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
        error: {
          code: "rate_limited" satisfies PorchHttpErrorCode,
          message: "a little slower, please"
        },
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
        : sseFrame("reaction", {
            target: event.target,
            emoji: event.emoji,
            proof: event.proof
          });
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

  /** Porch origin when Atlas is configured server-side; never the upstream URL. */
  private publicAtlasUrl(req: IncomingMessage): string | null {
    if (this.options.atlasUpstream === undefined) {
      return null;
    }
    const forwarded = req.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return requestOrigin(req.headers.host, proto, this.options.trustProxy);
  }

  private loadChainExport(): Promise<ChainExportResult> {
    const upstream = this.options.atlasUpstream;
    if (upstream === undefined) {
      return Promise.resolve({
        kind: "error",
        status: 503,
        code: "atlas_unconfigured" satisfies PorchHttpErrorCode,
        message: "chain export is not configured"
      });
    }
    return proxyChainExport({
      upstream,
      ...(this.options.atlasFetch === undefined ? {} : { fetchImpl: this.options.atlasFetch }),
      ...(this.options.exportTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.exportTimeoutMs }),
      ...(this.options.exportMaxBytes === undefined
        ? {}
        : { maxBytes: this.options.exportMaxBytes })
    });
  }

  private async handleChainExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.options.atlasUpstream === undefined) {
      this.chainExportError(res, 503, "atlas_unconfigured", "chain export is not configured");
      return;
    }
    const match = req.headers["if-none-match"];
    const ifNoneMatch = Array.isArray(match) ? match.join(", ") : match;
    const result = await this.exportGate.read(ifNoneMatch);
    this.writeChainExport(res, result);
  }

  /** Credential-free CORS so a shrine on another origin can read this one route. */
  private chainExportPreflight(res: ServerResponse): void {
    res.writeHead(204, {
      ...this.securityHeaders(),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "If-None-Match",
      "Access-Control-Max-Age": "600"
    });
    res.end();
  }

  private writeChainExport(res: ServerResponse, result: ChainExportResult): void {
    if (result.kind === "error") {
      this.forwardChainExportError(res, result.status, result.code, result.message);
      return;
    }
    const headers: Record<string, string> = {
      ...this.securityHeaders(),
      ...chainExportCors(),
      "Cache-Control": result.cacheControl ?? "no-cache"
    };
    if (result.etag !== null) {
      headers["ETag"] = result.etag;
    }
    if (result.status === 304) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers["Content-Type"] = "application/json; charset=utf-8";
    res.writeHead(200, headers);
    res.end(result.body);
  }

  /**
   * Write a porch-chosen chain-export error.
   * Upstream Atlas codes are not in {@link PorchHttpErrorCode}; those go through
   * {@link forwardChainExportError} unchanged.
   */
  private chainExportError(
    res: ServerResponse,
    status: number,
    code: PorchHttpErrorCode,
    message: string
  ): void {
    this.forwardChainExportError(res, status, code, message);
  }

  /**
   * Write a chain-export error body. `code` is a string because a failed Atlas
   * response forwards `error.code` as Atlas sent it.
   */
  private forwardChainExportError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string
  ): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, {
      ...this.securityHeaders(),
      ...chainExportCors(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ error: { code, message } }));
  }

  private sendAsset(
    req: IncomingMessage,
    res: ServerResponse,
    asset: StaticAsset,
    method: string
  ): void {
    const headers: Record<string, string> = {
      ...this.securityHeaders(),
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
      ETag: asset.etag
    };
    if (asset.corp !== undefined) {
      headers["Cross-Origin-Resource-Policy"] = asset.corp;
    }
    if (ifNoneMatch(req.headers["if-none-match"], asset.etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(method === "HEAD" ? "" : asset.body);
  }

  private methodNotAllowed(res: ServerResponse, allow: string): void {
    res.setHeader("Allow", allow);
    this.fail(res, 405, "method_not_allowed", "method not allowed");
  }

  private fail(
    res: ServerResponse,
    status: number,
    code: PorchHttpErrorCode,
    message: string
  ): void {
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
      ...this.securityHeaders(),
      "Content-Type": type,
      "Cache-Control": cache
    });
    res.end(body);
  }

  private securityHeaders(): Record<string, string> {
    return {
      ...SECURITY_HEADER_BASE,
      "Content-Security-Policy": contentSecurityPolicy()
    };
  }
}

function ifNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(", ") : header;
  return ifNoneMatchSatisfied(value, etag);
}

function chainExportCors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag"
  };
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
