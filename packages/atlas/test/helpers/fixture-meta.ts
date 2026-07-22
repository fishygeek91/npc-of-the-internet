import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DOOR_PUBLIC_KEY_B64,
  JOURNAL_EPOCH_1,
  JOURNAL_EPOCH_2,
  LEAK_SHARD_TEXT,
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
  doorPublicKey: string;
  doorPublicKeys: string[];
};

/** Load committed fixture metadata written by `generate:fixtures`. */
export async function loadFixtureMeta(
  fixtureDir = MULTI_RESIDENCY_FIXTURE_DIR
): Promise<FixtureMeta> {
  const raw = await readFile(join(fixtureDir, "fixture-meta.json"), "utf8");
  return JSON.parse(raw) as FixtureMeta;
}

/** Door public keys for verifying the multi-residency fixture chain. */
export const FIXTURE_DOOR_PUBLIC_KEYS_B64 = [DOOR_PUBLIC_KEY_B64, OTHER_DOOR_PUBLIC_KEY_B64];
