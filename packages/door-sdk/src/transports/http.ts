import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { z } from "zod";

import type { Door } from "../door.js";
import { DoorError, doorErrorToBody } from "../errors.js";
import {
  AttestRequestSchema,
  CosignRequestSchema,
  HeartbeatRequestSchema,
  type AttestRequest,
  type CosignRequest,
  type HeartbeatRequest
} from "../schemas.js";

/** Configuration for a minimal Node HTTP Door API server. */
export type HttpDoorServerOptions = {
  door: Door;
  /** Bind address; defaults to `127.0.0.1`. */
  host?: string;
  /** Listen port; defaults to `0` (ephemeral). */
  port?: number;
};

const JSON_CONTENT_TYPE = "application/json";

type RouteHandler = (body: unknown) => Promise<unknown>;

/**
 * Minimal `node:http` server exposing the Door REST endpoints:
 * `POST /door/hello`, `/door/heartbeat`, `/door/attest`, `/door/cosign`.
 */
export class HttpDoorServer {
  private readonly door: Door;
  private readonly host: string;
  private readonly port: number;
  private server: Server | null = null;

  constructor(options: HttpDoorServerOptions) {
    this.door = options.door;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
  }

  /** Start listening and return the bound address and base URL. */
  start(): Promise<{ host: string; port: number; baseUrl: string }> {
    if (this.server !== null) {
      return Promise.reject(new Error("HttpDoorServer is already started"));
    }

    const routes: Record<string, RouteHandler> = {
      // Hello: pass raw body so Door.hello can emit unsupported_version before schema parse.
      "/door/hello": async (body) => this.door.hello(body),
      "/door/heartbeat": async (body) => {
        const request = parseWithSchema<HeartbeatRequest>(HeartbeatRequestSchema, body);
        return this.door.heartbeat(request);
      },
      "/door/attest": async (body) => {
        const request = parseWithSchema<AttestRequest>(AttestRequestSchema, body);
        return this.door.attest(request);
      },
      "/door/cosign": async (body) => {
        const request = parseWithSchema<CosignRequest>(CosignRequestSchema, body);
        return this.door.cosign(request);
      }
    };

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res, routes);
    });

    return new Promise((resolve, reject) => {
      const server = this.server;
      if (server === null) {
        reject(new Error("HttpDoorServer failed to create server"));
        return;
      }
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("HttpDoorServer failed to resolve listen address"));
          return;
        }
        const boundHost = address.address === "::" ? "127.0.0.1" : address.address;
        const boundPort = address.port;
        resolve({
          host: boundHost,
          port: boundPort,
          baseUrl: `http://${boundHost}:${String(boundPort)}`
        });
      });
    });
  }

  /**
   * Underlying Node `http.Server` after {@link start} has resolved.
   * Attach WebSocket upgrades (e.g. `WsDoorSessionServer`) to share the same listener.
   *
   * @throws {Error} When called before {@link start} completes.
   */
  get nodeServer(): Server {
    const server = this.server;
    if (server === null) {
      throw new Error("HttpDoorServer is not started; call start() first");
    }
    return server;
  }

  /** Stop the HTTP server and release the listen socket. */
  stop(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return Promise.resolve();
    }
    this.server = null;
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    routes: Record<string, RouteHandler>
  ): Promise<void> {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method !== "POST") {
      this.sendJson(res, 404, {
        error: { code: "not_found", message: `method ${method} not allowed` }
      });
      return;
    }

    const handler = routes[pathname];
    if (handler === undefined) {
      this.sendJson(res, 404, {
        error: { code: "not_found", message: `path ${pathname} not found` }
      });
      return;
    }

    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, {
        error: { code: "invalid_request", message: "invalid JSON body" }
      });
      return;
    }

    try {
      const result = await handler(body);
      this.sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof DoorError) {
        this.sendJson(res, error.httpStatus, doorErrorToBody(error));
        return;
      }
      const message = error instanceof Error ? error.message : "internal server error";
      this.sendJson(res, 500, { error: { code: "internal_error", message } });
    }
  }

  private readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length === 0) {
          reject(new Error("empty body"));
          return;
        }
        try {
          resolve(JSON.parse(raw) as unknown);
        } catch {
          reject(new Error("invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": JSON_CONTENT_TYPE,
      "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
  }
}

/**
 * Parse and validate a JSON body with a Zod schema; throw DoorError on failure.
 */
function parseWithSchema<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw DoorError.fromCode("invalid_request", `invalid request: ${parsed.error.message}`);
  }
  return parsed.data;
}
