import WebSocket from "ws";

import { DoorError } from "../errors.js";
import {
  ControlFrameSchema,
  ErrorFrameSchema,
  InboundFrameSchema,
  OutboundFrameSchema,
  type Clock,
  type ControlFrame,
  type ErrorFrame,
  type InboundFrame,
  type OutboundFrame,
  type SessionBindParams
} from "../schemas.js";
import { WS_SESSION_BIND_FAILED } from "./ws.js";

/** Minimal WebSocket surface for {@link WsDoorSessionClient} (injectable in tests). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "open", listener: () => void): void;
  once(event: "close", listener: (code: number, reason: Buffer) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  removeAllListeners(event?: string): void;
}

/** Factory for a WebSocket implementation compatible with {@link WebSocketLike}. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Injectable clock for deterministic control-frame timestamps. */
type WsClock = Clock;

/** Options for {@link WsDoorSessionClient}. */
export type WsDoorSessionClientOptions = {
  /** WebSocket base URL without path (e.g. `ws://127.0.0.1:3000`); trailing slash is stripped. */
  wsBaseUrl: string;
  /** Session binding proof from arrival attest. */
  bind: SessionBindParams;
  /** Door-originated inbound community traffic. */
  onInbound?: (frame: InboundFrame) => void;
  /** Door-originated control frames (ping, session_end, …). */
  onControl?: (frame: ControlFrame) => void;
  /** Door-originated error frames. */
  onErrorFrame?: (frame: ErrorFrame) => void;
  /** Called when the session socket opens or closes (not including fatal bind failure). */
  onConnectionChange?: (connected: boolean) => void;
  /** Initial reconnect backoff in milliseconds; defaults to `1000`. */
  initialBackoffMs?: number;
  /** Maximum reconnect backoff in milliseconds; defaults to `30000`. */
  maxBackoffMs?: number;
  /** Injectable WebSocket factory; defaults to the `ws` package. */
  createWebSocket?: WebSocketFactory;
  /** Clock for outbound control-frame timestamps; defaults to system UTC. */
  clock?: WsClock;
  /** Injectable sleep for reconnect backoff (tests); defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
};

const WS_OPEN = 1;

const defaultClock: WsClock = {
  now(): string {
    return new Date().toISOString();
  }
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * WebSocket client for `WS /door/session` — session bind, inbound delivery,
 * outbound send, ping/pong, and automatic reconnect with exponential backoff.
 */
export class WsDoorSessionClient {
  private readonly wsBaseUrl: string;
  private readonly bind: SessionBindParams;
  private readonly onInbound: ((frame: InboundFrame) => void) | undefined;
  private readonly onControl: ((frame: ControlFrame) => void) | undefined;
  private readonly onErrorFrame: ((frame: ErrorFrame) => void) | undefined;
  private readonly onConnectionChange: ((connected: boolean) => void) | undefined;
  private readonly createWebSocket: WebSocketFactory;
  private readonly clock: WsClock;
  private readonly sleep: (ms: number) => Promise<void>;

  private initialBackoffMs: number;
  private maxBackoffMs: number;
  private currentBackoffMs: number;

  private socket: WebSocketLike | null = null;
  /** Socket created by an in-flight `connect()` before it is assigned to {@link socket}. */
  private openingSocket: WebSocketLike | null = null;
  private intentionallyClosed = false;
  private bindFailed = false;
  private reconnectGeneration = 0;
  private connectPromise: Promise<void> | null = null;

  constructor(options: WsDoorSessionClientOptions) {
    this.wsBaseUrl = options.wsBaseUrl.replace(/\/$/, "");
    this.bind = options.bind;
    this.onInbound = options.onInbound;
    this.onControl = options.onControl;
    this.onErrorFrame = options.onErrorFrame;
    this.onConnectionChange = options.onConnectionChange;
    this.createWebSocket = options.createWebSocket ?? ((url: string) => new WebSocket(url));
    this.clock = options.clock ?? defaultClock;
    this.sleep = options.sleep ?? defaultSleep;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.currentBackoffMs = this.initialBackoffMs;
  }

  /**
   * Open the session WebSocket with bind query parameters.
   * Resolves when the socket is open; rejects on fatal bind failure (close code 4401).
   */
  connect(): Promise<void> {
    if (this.intentionallyClosed) {
      return Promise.reject(new Error("WsDoorSessionClient is closed"));
    }
    if (this.bindFailed) {
      return Promise.reject(DoorError.fromCode("session_invalid", "session binding failed"));
    }
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }
    this.connectPromise = this.openSocket();
    return this.connectPromise;
  }

  /** Whether the session socket is currently open. */
  isConnected(): boolean {
    const socket = this.socket;
    return socket !== null && socket.readyState === WS_OPEN;
  }

  /** Send a signed outbound frame to the Door. */
  sendOutbound(frame: OutboundFrame): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WS_OPEN) {
      throw DoorError.fromCode("door_unavailable", "session socket is not connected");
    }
    const parsed = OutboundFrameSchema.safeParse(frame);
    if (!parsed.success) {
      throw DoorError.fromCode(
        "invalid_request",
        `invalid outbound frame: ${parsed.error.message}`
      );
    }
    socket.send(JSON.stringify(parsed.data));
  }

  /**
   * Stop reconnect attempts and close the session socket.
   * Safe to call multiple times. Also tears down an in-flight `connect()` socket
   * so a late `open` cannot reattach after shutdown.
   */
  async close(): Promise<void> {
    this.intentionallyClosed = true;
    this.cancelReconnect();
    const opening = this.openingSocket;
    const socket = this.socket;
    this.openingSocket = null;
    this.socket = null;
    this.connectPromise = null;

    const closers: Promise<void>[] = [];
    if (opening !== null) {
      closers.push(awaitSocketClose(opening));
    }
    if (socket !== null && socket !== opening) {
      closers.push(awaitSocketClose(socket));
    }
    await Promise.all(closers);
  }

  private buildSessionUrl(): string {
    const query = new URLSearchParams({
      door_id: this.bind.door_id,
      epoch: String(this.bind.epoch),
      session_pubkey: this.bind.session_pubkey,
      session_sig: this.bind.session_sig
    });
    return `${this.wsBaseUrl}/door/session?${query.toString()}`;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.buildSessionUrl();
      const socket = this.createWebSocket(url);
      this.openingSocket = socket;

      let settled = false;

      const settleClosedDuringConnect = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.openingSocket = null;
        this.connectPromise = null;
        reject(new Error("WsDoorSessionClient is closed"));
      };

      const settleOpen = (): void => {
        if (settled) {
          return;
        }
        if (this.intentionallyClosed) {
          settleClosedDuringConnect();
          socket.close();
          return;
        }
        settled = true;
        this.openingSocket = null;
        this.currentBackoffMs = this.initialBackoffMs;
        this.socket = socket;
        this.onConnectionChange?.(true);
        resolve();
      };

      const settleBindFailure = (message: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.bindFailed = true;
        this.openingSocket = null;
        this.connectPromise = null;
        reject(DoorError.fromCode("session_invalid", message));
      };

      socket.once("open", () => {
        queueMicrotask(() => {
          if (this.intentionallyClosed) {
            settleClosedDuringConnect();
            if (socket.readyState !== WebSocket.CLOSED) {
              socket.close();
            }
            return;
          }
          if (this.bindFailed || socket.readyState !== WS_OPEN) {
            return;
          }
          settleOpen();
        });
      });

      socket.once("close", (code) => {
        if (this.openingSocket === socket) {
          this.openingSocket = null;
        }
        if (!settled) {
          if (this.intentionallyClosed) {
            settleClosedDuringConnect();
            return;
          }
          if (code === WS_SESSION_BIND_FAILED) {
            this.bindFailed = true;
            settleBindFailure("session binding failed");
          } else {
            settled = true;
            this.connectPromise = null;
            reject(
              DoorError.fromCode(
                "door_unavailable",
                `connection closed before open (code ${String(code)})`
              )
            );
          }
          return;
        }
        if (code === WS_SESSION_BIND_FAILED) {
          this.bindFailed = true;
        }
        this.handleDisconnect(code, socket);
      });

      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          this.openingSocket = null;
          this.connectPromise = null;
          reject(
            DoorError.fromCode("door_unavailable", "WebSocket connection error", undefined, error)
          );
        }
      });

      socket.on("message", (data) => {
        this.handleMessage(data);
      });
    });
  }

  private handleDisconnect(code: number, closedSocket: WebSocketLike): void {
    if (this.socket !== closedSocket) {
      return;
    }
    this.socket = null;
    this.connectPromise = null;
    this.onConnectionChange?.(false);

    if (this.intentionallyClosed || this.bindFailed) {
      return;
    }

    if (code === WS_SESSION_BIND_FAILED) {
      this.bindFailed = true;
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed || this.bindFailed) {
      return;
    }

    const delayMs = this.currentBackoffMs;
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
    const generation = this.reconnectGeneration;

    void this.sleep(delayMs).then(() => {
      if (generation !== this.reconnectGeneration) {
        return;
      }
      if (this.intentionallyClosed || this.bindFailed) {
        return;
      }
      void this.openSocket()
        .catch(() => {
          if (!this.intentionallyClosed && !this.bindFailed) {
            this.scheduleReconnect();
          }
        })
        .finally(() => {
          this.connectPromise = null;
        });
    });
  }

  private cancelReconnect(): void {
    this.reconnectGeneration += 1;
  }

  private handleMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
    const text = this.messageToString(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return;
    }

    const frameType = typeof parsed.type === "string" ? parsed.type : null;
    if (frameType === null) {
      return;
    }

    if (frameType === "inbound") {
      const result = InboundFrameSchema.safeParse(parsed);
      if (result.success) {
        this.onInbound?.(result.data);
      }
      return;
    }

    if (frameType === "control") {
      const result = ControlFrameSchema.safeParse(parsed);
      if (!result.success) {
        return;
      }
      this.onControl?.(result.data);
      if (result.data.body.action === "ping") {
        this.sendPong(result.data);
      }
      return;
    }

    if (frameType === "error") {
      const result = ErrorFrameSchema.safeParse(parsed);
      if (result.success) {
        this.onErrorFrame?.(result.data);
      }
      return;
    }

    if (frameType === "outbound") {
      // Clients should not receive outbound frames from the Door; ignore.
      return;
    }
  }

  private sendPong(ping: ControlFrame): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WS_OPEN) {
      return;
    }
    const pong: ControlFrame = {
      type: "control",
      door_id: ping.door_id,
      epoch: ping.epoch,
      msg_id: ping.msg_id,
      issued_at: this.clock.now(),
      body: { action: "pong" }
    };
    socket.send(JSON.stringify(pong));
  }

  private messageToString(data: Buffer | ArrayBuffer | Buffer[]): string {
    if (typeof data === "string") {
      return data;
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    return data.toString("utf8");
  }
}

/** Close a socket and resolve when the `close` event fires (or immediately if already closed). */
function awaitSocketClose(socket: WebSocketLike): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}
