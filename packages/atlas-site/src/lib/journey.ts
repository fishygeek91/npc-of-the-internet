import { computeCid, type OspRecord } from "@npc/osp-core";

/** One arrival attestation on the Wanderer's journey timeline. */
export type JourneyEntry = {
  door_id: string;
  epoch: number;
  at: string;
  cid: string;
};

/**
 * Derive journey timeline entries from attestation arrivals (oldest to newest).
 */
export async function deriveJourney(records: readonly OspRecord[]): Promise<JourneyEntry[]> {
  const entries: JourneyEntry[] = [];

  for (const record of records) {
    if (record.type !== "attestation" || record.body.kind !== "arrival") {
      continue;
    }

    entries.push({
      door_id: record.body.door_id,
      epoch: record.body.epoch,
      at: record.body.at,
      cid: await computeCid(record)
    });
  }

  return entries;
}
