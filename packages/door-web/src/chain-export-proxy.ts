import { readBodyCapped, ResponseTooLargeError } from "@npc/door-sdk";

/** Largest Atlas export body the porch will buffer. */
export const CHAIN_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

/** How long the porch waits for Atlas before answering an error. */
export const CHAIN_EXPORT_TIMEOUT_MS = 5_000;

/** How long a successful export is reused before Atlas is asked again. */
export const CHAIN_EXPORT_CACHE_TTL_MS = 5_000;

/** Successful export kept for {@link CHAIN_EXPORT_CACHE_TTL_MS}. An error is not stored. */
type StoredExport = {
  body: Uint8Array;
  etag: string | null;
  cacheControl: string | null;
  storedAt: number;
};

/**
 * One Atlas export at a time, shared by concurrent visitors, then reused briefly.
 * `If-None-Match` is answered from that copy. A failed fetch is not kept.
 */
export class ChainExportGate {
  private stored: StoredExport | null = null;
  private inflight: Promise<ChainExportResult> | null = null;

  /**
   * @param load - Full upstream GET. Do not forward a visitor `If-None-Match`; the
   *   body has to be cacheable for every waiter.
   */
  constructor(
    private readonly load: () => Promise<ChainExportResult>,
    private readonly ttlMs: number = CHAIN_EXPORT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Answer from the fresh copy, or join the single upstream fetch. */
  async read(ifNoneMatch: string | undefined): Promise<ChainExportResult> {
    const stored = this.stored;
    if (stored !== null && this.now() - stored.storedAt < this.ttlMs) {
      return fromStored(stored, ifNoneMatch);
    }
    const pending = this.inflight ?? this.start();
    const result = await pending;
    if (result.kind === "ok" && result.status === 200) {
      return fromStored(
        {
          body: result.body,
          etag: result.etag,
          cacheControl: result.cacheControl,
          storedAt: this.now()
        },
        ifNoneMatch
      );
    }
    return result;
  }

  private start(): Promise<ChainExportResult> {
    const pending = this.load().then((result) => {
      if (result.kind === "ok" && result.status === 200) {
        this.stored = {
          body: result.body,
          etag: result.etag,
          cacheControl: result.cacheControl,
          storedAt: this.now()
        };
      }
      return result;
    });
    this.inflight = pending;
    void pending.finally(() => {
      if (this.inflight === pending) {
        this.inflight = null;
      }
    });
    return pending;
  }
}

/** True when `header` names `etag`, including a weak tag or a comma-separated list. */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  for (const part of header.split(",")) {
    const token = part.trim();
    const bare = token.startsWith("W/") || token.startsWith("w/") ? token.slice(2).trim() : token;
    if (bare === etag) {
      return true;
    }
  }
  return false;
}

function fromStored(stored: StoredExport, ifNoneMatch: string | undefined): ChainExportResult {
  if (stored.etag !== null && ifNoneMatchSatisfied(ifNoneMatch, stored.etag)) {
    return {
      kind: "ok",
      status: 304,
      body: new Uint8Array(0),
      etag: stored.etag,
      cacheControl: stored.cacheControl
    };
  }
  return {
    kind: "ok",
    status: 200,
    body: stored.body,
    etag: stored.etag,
    cacheControl: stored.cacheControl
  };
}

/**
 * Codes this proxy emits itself.
 * An Atlas error body is forwarded with that body's own `error.code`.
 */
type ProxyChainExportErrorCode = "atlas_timeout" | "atlas_unreachable" | "payload_too_large";

/**
 * Build a proxy-chosen chain-export error.
 * The result `code` is still a string so an Atlas wire code can share the same variant.
 */
function proxyChainExportError(
  status: number,
  code: ProxyChainExportErrorCode,
  message: string
): ChainExportResult {
  return { kind: "error", status, code, message };
}

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
      return proxyChainExportError(502, "payload_too_large", "atlas export is too large");
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
    return proxyChainExportError(504, "atlas_timeout", "atlas export timed out");
  }
  return proxyChainExportError(502, "atlas_unreachable", "atlas export could not be read");
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
  return proxyChainExportError(502, "atlas_unreachable", "atlas export could not be read");
}
