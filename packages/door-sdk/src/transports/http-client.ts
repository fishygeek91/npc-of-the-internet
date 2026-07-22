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
  type HelloResponse
} from "../schemas.js";

const JSON_CONTENT_TYPE = "application/json";

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
  hello(req: unknown): Promise<HelloResponse> {
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
      httpStatus
    );
  }
}
