import { z } from "zod";

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
 * Cached, failure-tolerant reader for atlas-api `GET /state`. At most one request per
 * {@link CACHE_MS} regardless of visitor traffic; any failure yields `null`.
 */
export class AtlasWhereabouts {
  private cached: { at: number; value: WandererWhereabouts | null } | null = null;
  private inflight: Promise<WandererWhereabouts | null> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly nowMs: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Latest whereabouts, or `null` when atlas is unreachable or answers nonsense. */
  async get(): Promise<WandererWhereabouts | null> {
    const now = this.nowMs();
    if (this.cached !== null && now - this.cached.at < CACHE_MS) {
      return this.cached.value;
    }
    this.inflight ??= this.fetchState().then((value) => {
      this.cached = { at: this.nowMs(), value };
      this.inflight = null;
      return value;
    });
    return this.inflight;
  }

  private async fetchState(): Promise<WandererWhereabouts | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/state`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        return null;
      }
      const parsed = StateSchema.safeParse(await response.json());
      if (!parsed.success) {
        return null;
      }
      return {
        status: parsed.data.status,
        door_id: parsed.data.door_id,
        since: parsed.data.since ?? parsed.data.last_record_at
      };
    } catch {
      return null;
    }
  }
}
