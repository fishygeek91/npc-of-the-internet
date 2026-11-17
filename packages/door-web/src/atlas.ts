import { readBodyCapped, ResponseTooLargeError } from "@npc/door-sdk";
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
    let json: unknown;
    try {
      const bytes = await readBodyCapped(response, ATLAS_STATE_MAX_BYTES, capAbort);
      if (!response.ok) {
        return null;
      }
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        throw new WebDoorError(
          "payload_too_large",
          `atlas response exceeds ${String(error.maxBytes)} bytes`
        );
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
