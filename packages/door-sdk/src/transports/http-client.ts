import { decodePublicKey, decodeSignature, verify } from "@npc/osp-core";
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
import {
  attestResponseSigningPayload,
  cosignCommitResponseSigningPayload,
  cosignReviewResponseSigningPayload,
  heartbeatResponseSigningPayload,
  helloResponseSigningPayload,
  verifyDoorCosig
} from "../signing.js";

const JSON_CONTENT_TYPE = "application/json";
/** Max characters of a non-Door error body retained in {@link DoorError.details}. */
const MAX_ERROR_BODY_CHARS = 512;

/**
 * Default client timeout for the `POST /door/cosign` **review** call (290 s).
 *
 * A review blocks on human host review, so it needs far longer than other calls. It must
 * exceed the Door's host review wait (door-discord `DISCORD_REVIEW_TIMEOUT_MS`, default
 * 240 s, plus posting time) and stays below Node's global `fetch` (undici) default
 * `headersTimeout` of 300 s, which would otherwise cut the request first with a less
 * explicit error (raising it needs a custom undici dispatcher, i.e. a new dependency).
 * A timed-out review is recoverable: the Wanderer re-signs and retries, and the Door joins
 * the in-flight review or replays the completed one (`spec/door/api.md`).
 */
export const DEFAULT_COSIGN_REVIEW_TIMEOUT_MS = 290_000;

/** Options for {@link HttpDoorConnection}. */
export type HttpDoorConnectionOptions = {
  /** Door HTTP base URL (e.g. `http://127.0.0.1:3000`); trailing slash is stripped. */
  baseUrl: string;
  /**
   * Client timeout (ms) for the cosign review call; defaults to
   * {@link DEFAULT_COSIGN_REVIEW_TIMEOUT_MS}. Values above 300 000 have no effect beyond
   * Node fetch's own 300 s headers timeout.
   */
  cosignReviewTimeoutMs?: number;
};

/**
 * HTTP client implementing {@link DoorConnection} against a remote Door REST API.
 * Posts JSON to `/door/hello`, `/door/attest`, `/door/heartbeat`, and `/door/cosign`.
 * Verifies Door response signatures per `spec/door/api.md` before returning.
 */
export class HttpDoorConnection implements DoorConnection {
  private readonly baseUrl: string;
  private readonly cosignReviewTimeoutMs: number;
  /** Door identity pubkey established by a verified hello response. */
  private doorPublicKey: Uint8Array | null = null;

  constructor(options: HttpDoorConnectionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.cosignReviewTimeoutMs = options.cosignReviewTimeoutMs ?? DEFAULT_COSIGN_REVIEW_TIMEOUT_MS;
  }

  /** `POST /door/hello` — discover Door identity and capabilities. */
  async hello(req: HelloRequest): Promise<HelloResponse> {
    const response = await this.post("/door/hello", req, HelloResponseSchema);
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

  /** `POST /door/attest` — arrival, departure, or heartbeat attestation. */
  async attest(request: AttestRequest): Promise<AttestResponse> {
    const doorPublicKey = this.requireDoorPublicKey();
    const response = await this.post("/door/attest", request, AttestResponseSchema);
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
    const response = await this.post("/door/heartbeat", request, HeartbeatResponseSchema);
    const { door_sig: doorSig, ...unsigned } = response;
    if (!verifyPayload(heartbeatResponseSigningPayload(unsigned), doorSig, doorPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: heartbeat response door_sig failed"
      );
    }
    return response;
  }

  /** `POST /door/cosign` — shard review or commit. */
  async cosign(request: CosignRequest): Promise<CosignResponse> {
    const doorPublicKey = this.requireDoorPublicKey();
    const response = await this.post(
      "/door/cosign",
      request,
      CosignResponseSchema,
      request.phase === "review" ? this.cosignReviewTimeoutMs : undefined
    );
    if (response.phase !== request.phase) {
      throw DoorError.fromCode(
        "invalid_request",
        `invalid_request: cosign response phase ${response.phase} does not match request phase ${request.phase}`
      );
    }
    if (response.phase === "review") {
      const { door_sig: doorSig, ...unsigned } = response;
      if (
        !verifyPayload(
          cosignReviewResponseSigningPayload({
            door_id: unsigned.door_id,
            epoch: unsigned.epoch,
            phase: unsigned.phase,
            decisions: unsigned.decisions,
            received_at: unsigned.received_at
          }),
          doorSig,
          doorPublicKey
        )
      ) {
        throw DoorError.fromCode(
          "signature_invalid",
          "signature_invalid: cosign review response door_sig failed"
        );
      }
      return response;
    }

    const { door_sig: doorSig, ...unsigned } = response;
    if (!verifyPayload(cosignCommitResponseSigningPayload(unsigned), doorSig, doorPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: cosign commit response door_sig failed"
      );
    }
    // Narrowed: response.phase === "commit" and phases match ⇒ request is commit.
    if (request.phase !== "commit") {
      throw DoorError.fromCode(
        "invalid_request",
        "invalid_request: cosign commit response without commit request"
      );
    }
    if (!verifyDoorCosig(request.core, response.door_cosig, doorPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: cosign commit response door_cosig failed"
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
    timeoutMs?: number
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: JSON.stringify(body),
        ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) })
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
