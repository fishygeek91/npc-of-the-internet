import { z } from "zod";

import { WebDoorError } from "./errors.js";

/** Where the Wanderer is now, per atlas-api `GET /state` (subset). */
export type WandererWhereabouts = {
  status: "present" | "traveling" | "sleeping";
  door_id: string | null;
  /** When the current status began (atlas `since`; older atlas: `last_record_at`). */
  since: string | null;
};

const StateSchema = z.object({
  status: z.enum(["present", "traveling", "sleeping"]),
  door_id: z.string().max(200).nullable(),
  since: z.string().max(64).nullable().optional(),
  last_record_at: z.string().max(64).nullable()
});

const CACHE_MS = 30_000;
const TIMEOUT_MS = 2_000;

/**
 * Max `GET /state` response body, in bytes.
 *
 * Atlas whereabouts is a handful of short fields (`status`, `door_id`, `epoch`,
 * `since`, `last_record_at`, `verified`) — a few hundred bytes. 64 KiB leaves
 * headroom for extra whitespace or a future field and still bounds memory
 * before Zod parses an operator-configured Atlas.
 */
export const ATLAS_STATE_MAX_BYTES = 64 * 1024;

/**
 * Cached reader for atlas-api `GET /state`. At most one request per {@link CACHE_MS}
 * regardless of visitor traffic. Network failures and unusable JSON yield `null`.
 * A body over {@link ATLAS_STATE_MAX_BYTES} throws {@link WebDoorError}
 * (`payload_too_large`) before `JSON.parse` and is not cached.
 */
export class AtlasWhereabouts {
  private cached: { at: number; value: WandererWhereabouts | null } | null = null;
  private inflight: Promise<WandererWhereabouts | null> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly nowMs: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * Latest whereabouts, or `null` when atlas is unreachable or the payload is nonsense.
   * Throws {@link WebDoorError} (`payload_too_large`) when the response exceeds
   * {@link ATLAS_STATE_MAX_BYTES}.
   */
  async get(): Promise<WandererWhereabouts | null> {
    const now = this.nowMs();
    if (this.cached !== null && now - this.cached.at < CACHE_MS) {
      return this.cached.value;
    }
    this.inflight ??= this.fetchState()
      .then((value) => {
        this.cached = { at: this.nowMs(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchState(): Promise<WandererWhereabouts | null> {
    const capAbort = new AbortController();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/state`, {
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), capAbort.signal]),
        headers: { accept: "application/json" }
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      await abortCappedRead(response, undefined, capAbort);
      return null;
    }
    let json: unknown;
    try {
      const text = await readCappedResponseText(response, ATLAS_STATE_MAX_BYTES, capAbort);
      json = JSON.parse(text);
    } catch (error) {
      if (error instanceof WebDoorError) {
        throw error;
      }
      return null;
    }
    const parsed = StateSchema.safeParse(json);
    if (!parsed.success) {
      return null;
    }
    return {
      status: parsed.data.status,
      door_id: parsed.data.door_id,
      since: parsed.data.since ?? parsed.data.last_record_at
    };
  }
}

/** Typed cap failure. The message names the limit only — never response bytes. */
function responseTooLarge(maxBytes: number): WebDoorError {
  return new WebDoorError("payload_too_large", `atlas response exceeds ${String(maxBytes)} bytes`);
}

/**
 * Read a response body as UTF-8, refusing anything over `maxBytes`.
 *
 * A Content-Length above the cap fails before the body is read. Otherwise the
 * body is streamed and the download is aborted as soon as the running total
 * exceeds the cap. Exactly `maxBytes` is accepted.
 */
async function readCappedResponseText(
  response: Response,
  maxBytes: number,
  abort: AbortController
): Promise<string> {
  if (contentLengthExceeds(response, maxBytes)) {
    await abortCappedRead(response, undefined, abort);
    throw responseTooLarge(maxBytes);
  }

  const body = response.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const value = next.value;
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.length = 0;
        await abortCappedRead(response, reader, abort);
        throw responseTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebDoorError) {
      throw error;
    }
    await abortCappedRead(response, reader, abort);
    throw error;
  }

  return new TextDecoder().decode(concatBytes(chunks));
}

/** True when Content-Length is a byte count strictly above `maxBytes`. */
function contentLengthExceeds(response: Response, maxBytes: number): boolean {
  const header = response.headers.get("content-length");
  if (header === null) {
    return false;
  }
  const trimmed = header.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return false;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return true;
  }
  return value > maxBytes;
}

/**
 * Abort the fetch and cancel the body. Swallows cancel failures so the size
 * error is what callers see.
 */
async function abortCappedRead(
  response: Response,
  reader: { cancel: () => Promise<void> } | undefined,
  abort: AbortController
): Promise<void> {
  abort.abort();
  try {
    if (reader !== undefined) {
      await reader.cancel();
      return;
    }
    if (response.body !== null) {
      await response.body.cancel();
    }
  } catch {
    // The peer may already have dropped the socket.
  }
}

/** Copy streamed chunks into one buffer. `chunks` together are at most the cap. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
