import { readBodyCapped, ResponseTooLargeError } from "@npc/door-sdk";

/** Largest Atlas export body the porch will buffer. */
export const CHAIN_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

/** How long the porch waits for Atlas before answering an error. */
export const CHAIN_EXPORT_TIMEOUT_MS = 5_000;

/** A pass-through of a successful Atlas export, or a public error. */
export type ChainExportResult =
  | {
      kind: "ok";
      status: 200 | 304;
      body: Uint8Array;
      etag: string | null;
      cacheControl: string | null;
    }
  | { kind: "error"; status: number; code: string; message: string };

/**
 * Fetch `GET {upstream}/chain/export` for a browser on the porch.
 * Forwards only `If-None-Match`. Does not send cookies or any other client header.
 */
export async function proxyChainExport(options: {
  upstream: string;
  ifNoneMatch?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<ChainExportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? CHAIN_EXPORT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CHAIN_EXPORT_MAX_BYTES;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.ifNoneMatch !== undefined && options.ifNoneMatch !== "") {
    headers["if-none-match"] = options.ifNoneMatch;
  }
  const abort = new AbortController();
  let response: Response;
  try {
    response = await fetchImpl(`${options.upstream.replace(/\/+$/u, "")}/chain/export`, {
      method: "GET",
      headers,
      credentials: "omit",
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), abort.signal]),
      cache: "no-store"
    });
  } catch (error) {
    return fetchFailed(error);
  }
  const etag = response.headers.get("etag");
  const cacheControl = response.headers.get("cache-control");
  if (response.status === 304) {
    await response.body?.cancel();
    return { kind: "ok", status: 304, body: new Uint8Array(0), etag, cacheControl };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(response, maxBytes, abort);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return {
        kind: "error",
        status: 502,
        code: "payload_too_large",
        message: "atlas export is too large"
      };
    }
    return fetchFailed(error);
  }
  if (!response.ok) {
    return publicAtlasError(response.status, bytes);
  }
  return { kind: "ok", status: 200, body: bytes, etag, cacheControl };
}

/**
 * Origin the browser used to reach the porch, or null when `Host` is unusable.
 * `trustProxy` honors a single `X-Forwarded-Proto` of `http` or `https`.
 */
export function requestOrigin(
  hostHeader: string | undefined,
  forwardedProto: string | undefined,
  trustProxy: boolean
): string | null {
  if (hostHeader === undefined || !/^[\w.-]+(?::\d{1,5})?$/u.test(hostHeader)) {
    return null;
  }
  let proto = "http";
  if (trustProxy && forwardedProto !== undefined) {
    const first = forwardedProto.split(",")[0]?.trim();
    if (first === "http" || first === "https") {
      proto = first;
    }
  }
  return `${proto}://${hostHeader}`;
}

function fetchFailed(error: unknown): ChainExportResult {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "error", status: 504, code: "atlas_timeout", message: "atlas export timed out" };
  }
  return {
    kind: "error",
    status: 502,
    code: "atlas_unreachable",
    message: "atlas export could not be read"
  };
}

function publicAtlasError(status: number, bytes: Uint8Array): ChainExportResult {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    payload = undefined;
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    "code" in payload.error &&
    "message" in payload.error &&
    typeof payload.error.code === "string" &&
    typeof payload.error.message === "string" &&
    status >= 400 &&
    status <= 599
  ) {
    return { kind: "error", status, code: payload.error.code, message: payload.error.message };
  }
  return {
    kind: "error",
    status: 502,
    code: "atlas_unreachable",
    message: "atlas export could not be read"
  };
}
