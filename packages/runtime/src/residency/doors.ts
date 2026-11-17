import {
  DOOR_PROTOCOL_VERSION,
  DoorError,
  HttpDoorConnection,
  type HelloResponse
} from "@npc/door-sdk";
import { encodePublicKey } from "@npc/osp-core";
import type { Logger } from "pino";

/** Default per-Door `hello` timeout while probing (10 s). */
export const DEFAULT_DOOR_PROBE_TIMEOUT_MS = 10_000;

/** Where one Door listens: HTTP base URL and the matching WebSocket base URL. */
export type DoorEndpoint = {
  baseUrl: string;
  wsBaseUrl: string;
};

/** A Door that answered a verified `hello` and is trusted by `ATLAS_DOOR_PUBKEYS`. */
export type AvailableDoor = {
  doorId: string;
  endpoint: DoorEndpoint;
  hello: HelloResponse;
};

/** Endpoint for a Door base URL: `http` → `ws`, `https` → `wss`; trailing slashes dropped. */
export function doorEndpoint(baseUrl: string): DoorEndpoint {
  const base = baseUrl.replace(/\/+$/u, "");
  return { baseUrl: base, wsBaseUrl: base.replace(/^http/iu, "ws") };
}

/**
 * Check a signature-verified `hello` against the trusted Door keys: the `door_id` must be
 * in `doorPublicKeys` and `door_pubkey` must equal that entry. Returns why the Door is
 * rejected, or `null` when it is trusted.
 */
export function verifyDoorHello(
  hello: HelloResponse,
  doorPublicKeys: Readonly<Record<string, Uint8Array>>
): string | null {
  const expected = Object.hasOwn(doorPublicKeys, hello.door_id)
    ? doorPublicKeys[hello.door_id]
    : undefined;
  if (expected === undefined) {
    return "door_id is not in ATLAS_DOOR_PUBKEYS";
  }
  if (encodePublicKey(expected) !== hello.door_pubkey) {
    return "door_pubkey differs from ATLAS_DOOR_PUBKEYS";
  }
  return null;
}

/**
 * `hello` one Door with a timeout. The returned connection has the Door identity pinned
 * by that verified `hello` (it checks every later attest response against it).
 */
export async function helloDoor(
  endpoint: DoorEndpoint,
  soulPublicKey: Uint8Array,
  timeoutMs: number = DEFAULT_DOOR_PROBE_TIMEOUT_MS
): Promise<{ connection: HttpDoorConnection; hello: HelloResponse }> {
  const connection = new HttpDoorConnection({ baseUrl: endpoint.baseUrl });
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    const hello = await Promise.race([
      connection.hello({
        protocol_version: DOOR_PROTOCOL_VERSION,
        soul_pubkey: encodePublicKey(soulPublicKey)
      }),
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => {
          reject(
            DoorError.fromCode(
              "door_unavailable",
              `door unavailable: hello timed out after ${String(timeoutMs)}ms`
            )
          );
        }, timeoutMs);
      })
    ]);
    return { connection, hello };
  } finally {
    clearTimeout(handle);
  }
}

/** Options for {@link probeDoors}. */
export type ProbeDoorsOptions = {
  endpoints: readonly DoorEndpoint[];
  soulPublicKey: Uint8Array;
  doorPublicKeys: Readonly<Record<string, Uint8Array>>;
  /** Per-Door `hello` timeout (default {@link DEFAULT_DOOR_PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
  logger: Pick<Logger, "warn">;
};

/**
 * `hello` every Door in parallel and return the available, trusted ones (endpoint order).
 * Unreachable Doors log `door_probe_failed`; untrusted ones (unknown `door_id`, wrong
 * `door_pubkey`, or a `door_id` already answered by an earlier URL) log `door_rejected`.
 * Never throws.
 */
export async function probeDoors(options: ProbeDoorsOptions): Promise<AvailableDoor[]> {
  const answers = await Promise.all(
    options.endpoints.map(async (endpoint): Promise<AvailableDoor | null> => {
      try {
        const { hello } = await helloDoor(endpoint, options.soulPublicKey, options.timeoutMs);
        const rejected = verifyDoorHello(hello, options.doorPublicKeys);
        if (rejected !== null) {
          options.logger.warn(
            { url: endpoint.baseUrl, door_id: hello.door_id, reason: rejected },
            "door_rejected"
          );
          return null;
        }
        return { doorId: hello.door_id, endpoint, hello };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn({ url: endpoint.baseUrl, err: message }, "door_probe_failed");
        return null;
      }
    })
  );

  const available: AvailableDoor[] = [];
  for (const door of answers) {
    if (door === null) {
      continue;
    }
    if (available.some((seen) => seen.doorId === door.doorId)) {
      options.logger.warn(
        { url: door.endpoint.baseUrl, door_id: door.doorId, reason: "duplicate door_id" },
        "door_rejected"
      );
      continue;
    }
    available.push(door);
  }
  return available;
}
