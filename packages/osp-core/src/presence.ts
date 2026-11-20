/**
 * Newest-first presence shared by Atlas, the porch, and the shrine.
 * No Node built-ins, so `@npc/osp-core/browser` can re-export this module.
 * The scan does not verify signatures.
 */

import type { OspRecord } from "./schemas/index.js";

/**
 * Arrival session key a porch uses for one epoch.
 * Informational for callers that already hold {@link OspRecord}s.
 */
export type EpochArrival = {
  doorId: string;
  epoch: number;
  /** `session_pubkey` on the `arrival` record. A heartbeat is not a second key. */
  sessionPubkey: string;
};

/**
 * Result of {@link scanPresence}.
 * Attestations carry `at`. A deciding `sleep` carries `asOf` instead.
 */
export type PresenceScan =
  | {
      status: "present";
      doorId: string;
      epoch: number;
      /** Index of the arrival or heartbeat that decided presence. */
      index: number;
      /** `at` on that record. */
      at: string;
    }
  | {
      status: "traveling";
      /** Departure `epoch`, travel `from_epoch`, or handover `depart_epoch`. */
      epoch: number;
      /** Index of the attestation that decided traveling. */
      index: number;
      /** `at` on that record. */
      at: string;
    }
  | {
      status: "sleeping";
      /** Sleep `as_of`, or null when the chain has no attestation. */
      asOf: string | null;
      /** Index of the sleep record, or null when the chain has no attestation. */
      index: number | null;
    };

/**
 * Newest-first presence of a chain, without verifying it.
 *
 * A `sleep` newer than every attestation is sleeping (`asOf` is `as_of`).
 * Otherwise the newest `arrival` or `heartbeat` is present at that door and
 * epoch. `departure` travels at `epoch`, `travel` at `from_epoch`, and
 * `handover` at `depart_epoch`. No attestation is sleeping with `asOf: null`.
 * `index` is the deciding record, or null when nothing decided. Atlas uses it
 * to walk `since`. Atlas `deriveState`, the porch, and the shrine share this
 * scan (`spec/door/web.md`).
 */
export function scanPresence(records: readonly OspRecord[]): PresenceScan {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }
    if (record.type === "sleep") {
      return { status: "sleeping", asOf: record.body.as_of, index };
    }
    if (record.type !== "attestation") {
      continue;
    }
    return presenceFromAttestation(record.body, index);
  }
  return { status: "sleeping", asOf: null, index: null };
}

/**
 * First `arrival` for this door and epoch, in chain order, or null.
 * Line verification uses this `session_pubkey`, including for a past epoch.
 * A later heartbeat is not a second key. A second arrival does not replace the first.
 */
export function arrivalForEpoch(
  records: readonly OspRecord[],
  doorId: string,
  epoch: number
): EpochArrival | null {
  for (const record of records) {
    const arrival = epochArrivalFrom(record, doorId);
    if (arrival !== null && arrival.epoch === epoch) {
      return arrival;
    }
  }
  return null;
}

/**
 * Every `arrival` at `doorId`, in chain order.
 * The same match as {@link arrivalForEpoch}: that door and `kind: "arrival"`.
 */
export function arrivalsForDoor(records: readonly OspRecord[], doorId: string): EpochArrival[] {
  const arrivals: EpochArrival[] = [];
  for (const record of records) {
    const arrival = epochArrivalFrom(record, doorId);
    if (arrival !== null) {
      arrivals.push(arrival);
    }
  }
  return arrivals;
}

/** Travel reports `from_epoch`. Handover reports `depart_epoch`. */
function presenceFromAttestation(
  body: Extract<OspRecord, { type: "attestation" }>["body"],
  index: number
): Exclude<PresenceScan, { status: "sleeping" }> {
  switch (body.kind) {
    case "arrival":
    case "heartbeat":
      return {
        status: "present",
        doorId: body.door_id,
        epoch: body.epoch,
        index,
        at: body.at
      };
    case "departure":
      return { status: "traveling", epoch: body.epoch, index, at: body.at };
    case "travel":
      return { status: "traveling", epoch: body.from_epoch, index, at: body.at };
    case "handover":
      return { status: "traveling", epoch: body.depart_epoch, index, at: body.at };
    default: {
      const unexpected: never = body;
      throw new Error(`unexpected attestation kind ${String(unexpected)}`);
    }
  }
}

function epochArrivalFrom(record: OspRecord, doorId: string): EpochArrival | null {
  if (record.type !== "attestation" || record.body.kind !== "arrival") {
    return null;
  }
  if (record.body.door_id !== doorId) {
    return null;
  }
  return {
    doorId: record.body.door_id,
    epoch: record.body.epoch,
    sessionPubkey: record.body.session_pubkey
  };
}
