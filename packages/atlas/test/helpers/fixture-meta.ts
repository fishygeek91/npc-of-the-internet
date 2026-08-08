import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePublicKey } from "@npc/osp-core";

import {
  DOOR_ID,
  DOOR_PUBLIC_KEY_B64,
  JOURNAL_EPOCH_1,
  JOURNAL_EPOCH_2,
  LEAK_SHARD_TEXT,
  OTHER_DOOR_ID,
  OTHER_DOOR_PUBLIC_KEY_B64
} from "./fixed-keys.js";

export { JOURNAL_EPOCH_1, JOURNAL_EPOCH_2, LEAK_SHARD_TEXT };

export const MULTI_RESIDENCY_FIXTURE_DIR = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "multi-residency"
);

export type FixtureMeta = {
  doorPublicKeys: Record<string, string>;
};

/** Load committed fixture metadata written by `generate:fixtures`. */
export async function loadFixtureMeta(
  fixtureDir = MULTI_RESIDENCY_FIXTURE_DIR
): Promise<FixtureMeta> {
  const raw = await readFile(join(fixtureDir, "fixture-meta.json"), "utf8");
  return JSON.parse(raw) as FixtureMeta;
}

/** Door public keys for verifying the multi-residency fixture chain. */
export const FIXTURE_DOOR_PUBLIC_KEYS_B64: Record<string, string> = {
  [DOOR_ID]: DOOR_PUBLIC_KEY_B64,
  [OTHER_DOOR_ID]: OTHER_DOOR_PUBLIC_KEY_B64
};

/** Decode fixture door public keys into a doorId → key map. */
export function fixtureDoorPublicKeys(): Readonly<Record<string, Uint8Array>> {
  const map: Record<string, Uint8Array> = {};
  for (const [doorId, keyB64] of Object.entries(FIXTURE_DOOR_PUBLIC_KEYS_B64)) {
    map[doorId] = decodePublicKey(keyB64);
  }
  return map;
}
