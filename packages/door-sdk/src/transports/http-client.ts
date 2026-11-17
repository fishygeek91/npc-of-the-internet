import { decodePublicKey, decodeSignature, verify } from "@npc/osp-core";
import type { z } from "zod";

import { DoorError } from "../errors.js";
import {
  AttestResponseSchema,
  DoorErrorBodySchema,
  HeartbeatResponseSchema,
  HelloResponseSchema,
  type AttestRequest,
  type AttestResponse,
  type DoorConnection,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HelloRequest,
  type HelloResponse
} from "../schemas.js";
import {
  attestResponseSigningPayload,
  heartbeatResponseSigningPayload,
  helloResponseSigningPayload,
  verifyDoorCosig
} from "../signing.js";

const JSON_CONTENT_TYPE = "application/json";
/** Max characters of a non-Door error body retained in {@link DoorError.details}. */
const MAX_ERROR_BODY_CHARS = 512;

/** Default client timeout for hello, heartbeat and presence attests (30 s). */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Default client timeout for a `memory` attest (180 s): the Door's witness may make a slow
 * model call (with a retry) before it answers. Stays below Node fetch's own 300 s headers
 * timeout.
 */
export const DEFAULT_MEMORY_ATTEST_TIMEOUT_MS = 180_000;

/** Options for {@link HttpDoorConnection}. */
export type HttpDoorConnectionOptions = {
  /** Door HTTP base URL (e.g. `http://127.0.0.1:3000`); trailing slash is stripped. */
  baseUrl: string;
  /** Timeout (ms) for hello, heartbeat and presence attests; default {@link DEFAULT_HTTP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Timeout (ms) for `memory` attests; default {@link DEFAULT_MEMORY_ATTEST_TIMEOUT_MS}. */
  memoryTimeoutMs?: number;
};

/**
 * HTTP client implementing {@link DoorConnection} against a remote Door REST API.
 * Posts JSON to `/door/hello`, `/door/attest`, and `/door/heartbeat`.
 * Verifies Door response signatures per `spec/door/api.md` before returning.
 */
export class HttpDoorConnection implements DoorConnection {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly memoryTimeoutMs: number;
  /** Door identity pubkey established by a verified hello response. */
  private doorPublicKey: Uint8Array | null = null;

  constructor(options: HttpDoorConnectionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.memoryTimeoutMs = options.memoryTimeoutMs ?? DEFAULT_MEMORY_ATTEST_TIMEOUT_MS;
  }

  /** `POST /door/hello` — discover Door identity and capabilities. */
  async hello(req: HelloRequest): Promise<HelloResponse> {
    const response = await this.post("/door/hello", req, HelloResponseSchema, this.timeoutMs);
    const { sig, ...unsigned } = response;
    const doorPublicKey = decodePublicKey(response.door_pubkey);
    if (!verifyPayload(helloResponseSigningPayload(unsigned), sig, doorPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: hello response sig failed under door_pubkey"
      );
    }
    this.doorPublicKey = doorPublicKey;
    return response;
  }

  /** `POST /door/attest` — presence attestation or witnessed memory (`kind: "memory"`). */
  async attest(request: AttestRequest): Promise<AttestResponse> {
    const doorPublicKey = this.requireDoorPublicKey();
    const response = await this.post(
      "/door/attest",
      request,
      AttestResponseSchema,
      request.kind === "memory" ? this.memoryTimeoutMs : this.timeoutMs
    );
    const { door_sig: doorSig, ...unsigned } = response;
    if (!verifyPayload(attestResponseSigningPayload(unsigned), doorSig, doorPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: attest response door_sig failed"
      );
    }
    if (!verifyDoorCosig(request.core, response.door_cosig, doorPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: attest response door_cosig failed"
      );
    }
    return response;
  }

  /** `POST /door/heartbeat` — session presence ping. */
  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    const doorPublicKey = this.requireDoorPublicKey();
    const response = await this.post(
      "/door/heartbeat",
      request,
      HeartbeatResponseSchema,
      this.timeoutMs
    );
    const { door_sig: doorSig, ...unsigned } = response;
    if (!verifyPayload(heartbeatResponseSigningPayload(unsigned), doorSig, doorPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: heartbeat response door_sig failed"
      );
    }
    return response;
  }

  private requireDoorPublicKey(): Uint8Array {
    if (this.doorPublicKey === null) {
      throw DoorError.fromCode(
        "session_invalid",
        "session_invalid: call hello() and verify Door identity before other requests"
      );
    }
    return this.doorPublicKey;
  }

  private async post<T>(
    path: string,
    body: unknown,
    successSchema: z.ZodType<T>,
    timeoutMs: number
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      throw DoorError.fromCode(
        "door_unavailable",
        isTimeoutError(cause)
          ? `door unavailable: request timed out after ${String(timeoutMs)}ms`
          : "door unavailable: network request failed",
        undefined,
        cause
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      if (isTimeoutError(cause)) {
        throw DoorError.fromCode(
          "door_unavailable",
          `door unavailable: request timed out after ${String(timeoutMs)}ms`,
          undefined,
          cause
        );
      }
      throw new DoorError(
        "door_unavailable",
        `door unavailable: non-JSON response (HTTP ${String(response.status)})`,
        response.status
      );
    }

    if (!response.ok) {
      throw this.parseDoorError(json, response.status);
    }

    const parsed = successSchema.safeParse(json);
    if (!parsed.success) {
      throw DoorError.fromCode(
        "door_unavailable",
        `door unavailable: invalid success response: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  private parseDoorError(json: unknown, httpStatus: number): DoorError {
    const parsed = DoorErrorBodySchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      return new DoorError(code, message, httpStatus, details);
    }
    return new DoorError(
      "door_unavailable",
      `door unavailable: HTTP ${String(httpStatus)}`,
      httpStatus,
      { body: summarizeErrorBody(json) }
    );
  }
}

/** True for the `AbortSignal.timeout` rejection (`TimeoutError` DOMException). */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** Verify Ed25519 signature over already-canonical payload bytes. */
function verifyPayload(payload: Uint8Array, sig: string, publicKey: Uint8Array): boolean {
  return verify(payload, decodeSignature(sig), publicKey);
}

/**
 * Compact, non-secret-safe summary of an unexpected error response body for operator logs.
 */
function summarizeErrorBody(json: unknown): string {
  let text: string;
  try {
    text = typeof json === "string" ? json : JSON.stringify(json);
  } catch {
    text = "[unserializable]";
  }
  if (text.length <= MAX_ERROR_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}
