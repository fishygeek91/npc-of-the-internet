import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

import type { Door } from "../door.js";
import { DoorError, doorErrorToBody } from "../errors.js";
import {
  ControlFrameSchema,
  OutboundFrameSchema,
  SessionBindParamsSchema,
  type ErrorFrame,
  type InboundFrame,
  type SessionBindParams
} from "../schemas.js";

/** WebSocket close code for failed session binding per `spec/door/api.md`. */
export const WS_SESSION_BIND_FAILED = 4401;

/** Configuration for the Door WebSocket session server. */
export type WsDoorSessionServerOptions = {
  door: Door;
  /** Bind address when creating an internal HTTP server; defaults to `127.0.0.1`. */
  host?: string;
  /** Listen port when creating an internal HTTP server; defaults to `0` (ephemeral). */
  port?: number;
  /** Optional existing `http.Server` to attach upgrades to. */
  server?: Server;
};

type BoundClient = {
  socket: WebSocket;
  doorId: string;
  epoch: number;
};

/**
 * WebSocket server for `WS /door/session` — session binding, outbound frames,
 * control ping/pong, and test helpers for inbound broadcast.
 */
export class WsDoorSessionServer {
  private readonly door: Door;
  private readonly host: string;
  private readonly port: number;
  private readonly externalServer: Server | undefined;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null =
    null;
  private readonly clients = new Set<BoundClient>();
  private errorMsgCounter = 0;

  constructor(options: WsDoorSessionServerOptions) {
    this.door = options.door;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.externalServer = options.server;
  }

  /** Start the WebSocket session endpoint and return its URL. */
  start(): Promise<{ host: string; port: number; url: string }> {
    if (this.wss !== null) {
      return Promise.reject(new Error("WsDoorSessionServer is already started"));
    }

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    const upgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
      const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
        .pathname;
      if (pathname !== "/door/session") {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, req);
      });
    };
    this.upgradeHandler = upgradeHandler;

    if (this.externalServer !== undefined) {
      this.externalServer.on("upgrade", upgradeHandler);
      const address = this.externalServer.address();
      if (address === null || address === undefined) {
        return Promise.reject(new Error("external server is not listening"));
      }
      if (typeof address === "string") {
        return Promise.reject(new Error("unsupported external server address"));
      }
      const boundHost = address.address === "::" ? "127.0.0.1" : address.address;
      return Promise.resolve({
        host: boundHost,
        port: address.port,
        url: `ws://${boundHost}:${String(address.port)}/door/session`
      });
    }

    const httpServer = createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
    });
    this.server = httpServer;
    httpServer.on("upgrade", upgradeHandler);

    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(this.port, this.host, () => {
        const address = httpServer.address();
        if (address === null || address === undefined || typeof address === "string") {
          reject(new Error("WsDoorSessionServer failed to resolve listen address"));
          return;
        }
        const boundHost = address.address === "::" ? "127.0.0.1" : address.address;
        const boundPort = address.port;
        resolve({
          host: boundHost,
          port: boundPort,
          url: `ws://${boundHost}:${String(boundPort)}/door/session`
        });
      });
    });
  }

  /** Stop the server, close clients, and release resources. */
  stop(): Promise<void> {
    const closeSocket = (socket: WebSocket): Promise<void> =>
      new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close();
      });

    const clientSockets = [...this.clients].map((client) => client.socket);
    this.clients.clear();

    const wss = this.wss;
    this.wss = null;

    const listener = this.upgradeHandler;
    this.upgradeHandler = null;
    if (listener !== null) {
      const target = this.externalServer ?? this.server;
      target?.off("upgrade", listener);
    }

    const closeWss = (): Promise<void> =>
      new Promise((resolve, reject) => {
        if (wss === null) {
          resolve();
          return;
        }
        wss.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });

    const closeHttp = (): Promise<void> => {
      const httpServer = this.server;
      this.server = null;
      if (httpServer === null) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    };

    return Promise.all(clientSockets.map((socket) => closeSocket(socket)))
      .then(() => closeWss())
      .then(() => closeHttp())
      .then(() => undefined);
  }

  /**
   * Broadcast a Door-originated inbound frame to all bound session clients.
   * Used by tests to simulate community-originated traffic.
   */
  broadcastInbound(body: InboundFrame["body"], msg_id: string): void {
    const frame = this.door.createInboundFrame({ body, msg_id });
    const payload = JSON.stringify(frame);
    for (const client of this.clients) {
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  /** Open WebSocket clients after successful session binding. */
  getActiveClients(): ReadonlySet<WebSocket> {
    const sockets = new Set<WebSocket>();
    for (const client of this.clients) {
      sockets.add(client.socket);
    }
    return sockets;
  }

  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const bindResult = this.parseBindParams(url.searchParams);
    if (bindResult.ok === false) {
      socket.close(WS_SESSION_BIND_FAILED, bindResult.message);
      return;
    }

    try {
      this.door.bindSession(bindResult.params);
    } catch (error) {
      const message = error instanceof DoorError ? error.message : "session binding failed";
      socket.close(WS_SESSION_BIND_FAILED, message);
      return;
    }

    const client: BoundClient = {
      socket,
      doorId: bindResult.params.door_id,
      epoch: bindResult.params.epoch
    };
    this.clients.add(client);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.sendErrorFrame(
          client,
          DoorError.fromCode("invalid_request", "binary frames are not supported")
        );
        return;
      }

      const text = typeof data === "string" ? data : data.toString("utf8");
      void this.handleTextMessage(client, text);
    });

    socket.on("close", () => {
      this.clients.delete(client);
    });
  }

  private parseBindParams(
    searchParams: URLSearchParams
  ): { ok: true; params: SessionBindParams } | { ok: false; message: string } {
    const epochRaw = searchParams.get("epoch");
    const epochParsed = epochRaw === null ? undefined : Number.parseInt(epochRaw, 10);

    const parsed = SessionBindParamsSchema.safeParse({
      door_id: searchParams.get("door_id") ?? undefined,
      epoch: epochParsed !== undefined && Number.isNaN(epochParsed) ? epochRaw : epochParsed,
      session_pubkey: searchParams.get("session_pubkey") ?? undefined,
      session_sig: searchParams.get("session_sig") ?? undefined
    });

    if (!parsed.success) {
      return { ok: false, message: parsed.error.message };
    }
    return { ok: true, params: parsed.data };
  }

  private async handleTextMessage(client: BoundClient, text: string): Promise<void> {
    let parsed: { type?: string; msg_id?: string };
    try {
      parsed = JSON.parse(text) as { type?: string; msg_id?: string };
    } catch {
      this.sendErrorFrame(
        client,
        DoorError.fromCode("invalid_request", "invalid JSON frame"),
        undefined
      );
      return;
    }

    const frameType = parsed.type;
    if (frameType === "outbound") {
      const frameResult = OutboundFrameSchema.safeParse(parsed);
      if (!frameResult.success) {
        this.sendErrorFrame(
          client,
          DoorError.fromCode("invalid_request", frameResult.error.message),
          undefined
        );
        return;
      }
      try {
        this.door.handleOutbound(frameResult.data);
      } catch (error) {
        if (error instanceof DoorError) {
          this.sendErrorFrame(client, error, frameResult.data.msg_id);
        } else {
          this.sendErrorFrame(
            client,
            DoorError.fromCode("internal_error", "outbound frame handling failed"),
            frameResult.data.msg_id
          );
        }
      }
      return;
    }

    if (frameType === "control") {
      const frameResult = ControlFrameSchema.safeParse(parsed);
      if (!frameResult.success) {
        this.sendErrorFrame(
          client,
          DoorError.fromCode("invalid_request", frameResult.error.message),
          undefined
        );
        return;
      }
      const pong = this.door.handleControl(frameResult.data);
      if (pong !== null) {
        client.socket.send(JSON.stringify(pong));
      }
      return;
    }

    if (frameType === "inbound") {
      this.sendErrorFrame(
        client,
        DoorError.fromCode("invalid_request", "clients must not send inbound frames"),
        parsed.msg_id
      );
      return;
    }

    this.sendErrorFrame(
      client,
      DoorError.fromCode("invalid_request", `unsupported frame type: ${String(frameType)}`),
      parsed.msg_id
    );
  }

  private sendErrorFrame(client: BoundClient, err: DoorError, relatedMsgId?: string): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const frame = this.buildErrorFrame(client, err, relatedMsgId);
    client.socket.send(JSON.stringify(frame));
  }

  private buildErrorFrame(client: BoundClient, err: DoorError, relatedMsgId?: string): ErrorFrame {
    this.errorMsgCounter += 1;
    const msgId = `err_${String(this.errorMsgCounter)}`;

    const body: ErrorFrame["body"] = {
      error: doorErrorToBody(err).error
    };
    if (relatedMsgId !== undefined) {
      body.related_msg_id = relatedMsgId;
    }

    return {
      type: "error",
      door_id: client.doorId,
      epoch: client.epoch,
      msg_id: msgId,
      issued_at: this.door.now(),
      body
    };
  }
}
