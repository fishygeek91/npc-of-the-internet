import { readBodyCapped, ResponseTooLargeError } from "@npc/door-sdk";
import { isValidCid } from "@npc/osp-core";

/** Largest Atlas export body the porch will buffer. */
export const CHAIN_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

/** How long the porch waits for Atlas before answering an error. */
export const CHAIN_EXPORT_TIMEOUT_MS = 5_000;

/** How long a successful export is reused before Atlas is asked again. */
export const CHAIN_EXPORT_CACHE_TTL_MS = 5_000;

/**
 * Tail bodies kept per porch process. The full export sits beside this LRU.
 * Record CIDs are public, so an unbounded map would retain a body per cursor.
 */
export const CHAIN_EXPORT_TAIL_CACHE_ENTRIES = 16;

/**
 * Bytes of tail bodies one porch will retain. Two maximum responses, not one
 * per public cursor. The full export is not counted here.
 */
export const CHAIN_EXPORT_TAIL_CACHE_BYTES = 2 * CHAIN_EXPORT_MAX_BYTES;

/** Upstream tail fetches allowed at once. A further tail is `atlas_busy`. */
export const CHAIN_EXPORT_TAIL_LOADS = 2;

/** `Retry-After` seconds on `503` `atlas_busy`. */
export const CHAIN_EXPORT_BUSY_RETRY_AFTER = 1;

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
    this.releaseExpired();
    const stored = this.stored;
    if (stored !== null) {
      return fromStored(stored, ifNoneMatch);
    }
    const pending = this.inflight ?? this.start();
    const result = await pending;
    if (result.kind === "ok" && result.status === 200) {
      const kept = this.stored;
      if (kept !== null) {
        return fromStored(kept, ifNoneMatch);
      }
    }
    return result;
  }

  /** True while this gate is waiting on Atlas. */
  isInflight(): boolean {
    return this.inflight !== null;
  }

  /**
   * Bytes of the body still inside the TTL.
   * A body older than the TTL is dropped here, not kept until the next store.
   */
  heldBytes(): number {
    this.releaseExpired();
    const stored = this.stored;
    if (stored === null) {
      return 0;
    }
    return stored.body.byteLength;
  }

  /** Drop the retained body. An in-flight load is left running. */
  releaseStored(): void {
    this.stored = null;
  }

  /** Forget a body once `now` says its TTL has elapsed. */
  releaseExpired(): void {
    const stored = this.stored;
    if (stored !== null && this.now() - stored.storedAt >= this.ttlMs) {
      this.stored = null;
    }
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
  | {
      kind: "error";
      status: number;
      code: string;
      message: string;
      /** Seconds for `Retry-After` when the porch refuses a tail with `atlas_busy`. */
      retryAfter?: number;
    };

type TailSlot = { gate: ChainExportGate; bytes: number };

/**
 * One full export plus a bounded LRU of tails, each with its own TTL and inflight fetch.
 * `after` is the validated CID. Undefined is the full export and is not evicted by tails.
 * Tails are also capped by total retained bytes and by how many upstream loads may run.
 */
export class ChainExportCache {
  private readonly full: ChainExportGate;
  private readonly tails = new Map<string, TailSlot>();
  private tailLoads = 0;

  constructor(
    private readonly load: (after: string | undefined) => Promise<ChainExportResult>,
    ttlMs: number = CHAIN_EXPORT_CACHE_TTL_MS,
    now: () => number = Date.now,
    private readonly tailLimit: number = CHAIN_EXPORT_TAIL_CACHE_ENTRIES,
    private readonly tailByteLimit: number = CHAIN_EXPORT_TAIL_CACHE_BYTES,
    private readonly tailLoadLimit: number = CHAIN_EXPORT_TAIL_LOADS
  ) {
    this.full = new ChainExportGate(() => this.load(undefined), ttlMs, now);
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private readonly ttlMs: number;
  private readonly now: () => number;

  /** Answer the full export, or the tail for one CID, from that key's gate. */
  read(after: string | undefined, ifNoneMatch: string | undefined): Promise<ChainExportResult> {
    if (after === undefined) {
      this.full.releaseExpired();
      return this.full.read(ifNoneMatch);
    }
    return this.readTail(after, ifNoneMatch);
  }

  /**
   * Bytes of tail bodies still inside the TTL.
   * Expired bodies are released before the count, so a quiet cache does not keep them.
   */
  cachedTailBytes(): number {
    this.sweep();
    return this.totalBytes();
  }

  private async readTail(
    after: string,
    ifNoneMatch: string | undefined
  ): Promise<ChainExportResult> {
    this.sweep();
    const existing = this.tails.get(after);
    if (existing !== undefined && existing.gate.heldBytes() > 0) {
      this.touch(after, existing);
      return existing.gate.read(ifNoneMatch);
    }
    if (existing !== undefined && existing.gate.isInflight()) {
      this.touch(after, existing);
      const joined = await existing.gate.read(ifNoneMatch);
      this.account(after);
      return joined;
    }
    if (this.tailLoads >= this.tailLoadLimit) {
      return {
        kind: "error",
        status: 503,
        code: "atlas_busy",
        message: "chain export is busy",
        retryAfter: CHAIN_EXPORT_BUSY_RETRY_AFTER
      };
    }
    const slot = existing ?? {
      gate: new ChainExportGate(() => this.load(after), this.ttlMs, this.now),
      bytes: 0
    };
    this.touch(after, slot);
    this.tailLoads += 1;
    try {
      const result = await slot.gate.read(ifNoneMatch);
      this.account(after);
      return result;
    } finally {
      this.tailLoads -= 1;
    }
  }

  private touch(after: string, slot: TailSlot): void {
    this.tails.delete(after);
    this.tails.set(after, slot);
  }

  /** Drop expired tail bodies and forget gates that no longer hold one. */
  private sweep(): void {
    this.full.releaseExpired();
    for (const [key, slot] of this.tails) {
      slot.bytes = slot.gate.heldBytes();
      if (slot.bytes === 0 && !slot.gate.isInflight()) {
        this.tails.delete(key);
      }
    }
  }

  /** Record what `after` retained, then evict until both caps hold. */
  private account(after: string): void {
    const slot = this.tails.get(after);
    if (slot === undefined) {
      return;
    }
    slot.bytes = slot.gate.heldBytes();
    if (slot.bytes === 0 && !slot.gate.isInflight()) {
      this.tails.delete(after);
      return;
    }
    this.evict();
  }

  private evict(): void {
    while (this.tails.size > this.tailLimit || this.totalBytes() > this.tailByteLimit) {
      const oldest = this.oldestEvictable();
      if (oldest === undefined) {
        return;
      }
      const slot = this.tails.get(oldest);
      if (slot !== undefined) {
        slot.gate.releaseStored();
      }
      this.tails.delete(oldest);
    }
  }

  /** Oldest tail that is not waiting on Atlas, so an in-flight body is not orphaned. */
  private oldestEvictable(): string | undefined {
    for (const [key, slot] of this.tails) {
      if (!slot.gate.isInflight()) {
        return key;
      }
    }
    return undefined;
  }

  private totalBytes(): number {
    let total = 0;
    for (const slot of this.tails.values()) {
      total += slot.bytes;
    }
    return total;
  }
}

/**
 * Read `after` from a porch request URL. Absent means the full export.
 * The value is not trimmed or rewritten. A present value that is not a CID,
 * a repeated `after`, or a broken percent-encoding is rejected.
 */
export function parsePorchExportAfter(
  url: string
): { ok: true; after: string | undefined } | { ok: false } {
  const queryIndex = url.indexOf("?");
  if (queryIndex < 0) {
    return { ok: true, after: undefined };
  }
  const query = url.slice(queryIndex + 1);
  let found: string | undefined;
  let seen = false;
  for (const part of query.split("&")) {
    if (part.length === 0) {
      continue;
    }
    const eq = part.indexOf("=");
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? "" : part.slice(eq + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      return { ok: false };
    }
    if (key !== "after") {
      continue;
    }
    if (seen) {
      return { ok: false };
    }
    seen = true;
    found = value;
  }
  if (!seen || found === undefined) {
    return { ok: true, after: undefined };
  }
  if (!isValidCid(found)) {
    return { ok: false };
  }
  return { ok: true, after: found };
}

/**
 * Fetch `GET {upstream}/chain/export` for a browser on the porch.
 * Forwards `after` only when the caller already validated it as a CID, and
 * `If-None-Match` when the caller passes one. Does not send cookies or any
 * other client header. The byte cap applies to this response, tail or full.
 */
export async function proxyChainExport(options: {
  upstream: string;
  after?: string;
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
  const suffix = options.after === undefined ? "" : `?after=${options.after}`;
  try {
    response = await fetchImpl(`${options.upstream.replace(/\/+$/u, "")}/chain/export${suffix}`, {
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
