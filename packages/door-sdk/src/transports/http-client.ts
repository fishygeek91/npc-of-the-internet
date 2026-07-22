import type { z } from "zod";

import { DoorError } from "../errors.js";
import {
  AttestResponseSchema,
  CosignResponseSchema,
  DoorErrorBodySchema,
  HeartbeatResponseSchema,
  HelloResponseSchema,
  type AttestRequest,
  type AttestResponse,
  type CosignRequest,
  type CosignResponse,
  type DoorConnection,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HelloRequest,
  type HelloResponse
} from "../schemas.js";

const JSON_CONTENT_TYPE = "application/json";
/** Max characters of a non-Door error body retained in {@link DoorError.details}. */
const MAX_ERROR_BODY_CHARS = 512;

/** Options for {@link HttpDoorConnection}. */
export type HttpDoorConnectionOptions = {
  /** Door HTTP base URL (e.g. `http://127.0.0.1:3000`); trailing slash is stripped. */
  baseUrl: string;
};

/**
 * HTTP client implementing {@link DoorConnection} against a remote Door REST API.
 * Posts JSON to `/door/hello`, `/door/attest`, `/door/heartbeat`, and `/door/cosign`.
 */
export class HttpDoorConnection implements DoorConnection {
  private readonly baseUrl: string;

  constructor(options: HttpDoorConnectionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  /** `POST /door/hello` — discover Door identity and capabilities. */
  hello(req: HelloRequest): Promise<HelloResponse> {
    return this.post("/door/hello", req, HelloResponseSchema);
  }

  /** `POST /door/attest` — arrival, departure, or heartbeat attestation. */
  attest(request: AttestRequest): Promise<AttestResponse> {
    return this.post("/door/attest", request, AttestResponseSchema);
  }

  /** `POST /door/heartbeat` — session presence ping. */
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.post("/door/heartbeat", request, HeartbeatResponseSchema);
  }

  /** `POST /door/cosign` — shard review or commit. */
  cosign(request: CosignRequest): Promise<CosignResponse> {
    return this.post("/door/cosign", request, CosignResponseSchema);
  }

  private async post<T>(path: string, body: unknown, successSchema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      throw DoorError.fromCode(
        "door_unavailable",
        "door unavailable: network request failed",
        undefined,
        cause
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
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

/**
 * Compact, non-secret-safe summary of an unexpected error response body for operator logs.
 * Truncates long JSON so proxy/gateway payloads stay readable in {@link DoorError.details}.
 */
function summarizeErrorBody(json: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(json);
  } catch {
    raw = Object.prototype.toString.call(json);
  }
  if (raw.length <= MAX_ERROR_BODY_CHARS) {
    return raw;
  }
  return `${raw.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}
