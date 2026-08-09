import * as path from "node:path";

import { CorruptionError } from "../errors.js";
import { readHead } from "../store/head-file.js";
import { readSeqIndex } from "../store/seq-index.js";

import { buildUnsignedPinManifest, signPinManifest, type PinManifest } from "./pin-manifest.js";

const SEQ_INDEX_FILE = "seq-index.jsonl";

/** Options for {@link buildAndSignPinManifestForIpfsDir}. */
export type BuildPinManifestForIpfsDirOptions = {
  generatedAt: string;
  prevManifestCid?: string | null;
};

/**
 * List record CIDs from an IpfsSoulStore directory via seq-index (not iterate).
 *
 * Validates contiguous seq 0..n-1 and that HEAD matches the last entry.
 */
export async function listRecordCidsFromIpfsDir(dir: string): Promise<string[]> {
  const absoluteDir = path.resolve(dir);
  const entries = await readSeqIndex(path.join(absoluteDir, SEQ_INDEX_FILE));

  if (entries.length === 0) {
    throw new CorruptionError("seq-index is empty; cannot build pin manifest");
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      throw new CorruptionError(`missing seq-index entry at position ${index}`);
    }
    if (entry.seq !== index) {
      throw new CorruptionError(
        `seq-index gap: expected seq ${index} at position ${index}, found ${entry.seq}`
      );
    }
  }

  const head = await readHead(absoluteDir);
  const lastEntry = entries[entries.length - 1];
  if (lastEntry === undefined) {
    throw new CorruptionError("seq-index is empty after validation");
  }

  if (head === null) {
    throw new CorruptionError("HEAD is missing but seq-index has entries");
  }

  if (head.cid !== lastEntry.cid || head.seq !== lastEntry.seq) {
    throw new CorruptionError(
      `HEAD does not match last seq-index entry: head ${head.cid}@${head.seq}, index ${lastEntry.cid}@${lastEntry.seq}`
    );
  }

  return entries.map((entry) => entry.cid);
}

/**
 * Build and soul-sign a pin manifest from an on-disk IpfsSoulStore layout.
 */
export async function buildAndSignPinManifestForIpfsDir(
  dir: string,
  soulPrivateKey: Uint8Array,
  options: BuildPinManifestForIpfsDirOptions
): Promise<PinManifest> {
  const recordCids = await listRecordCidsFromIpfsDir(dir);
  const genesisCid = recordCids[0];
  const headCid = recordCids[recordCids.length - 1];

  if (genesisCid === undefined || headCid === undefined) {
    throw new CorruptionError("seq-index is empty; cannot build pin manifest");
  }

  const unsigned = buildUnsignedPinManifest({
    headCid,
    genesisCid,
    recordCids,
    seq: recordCids.length - 1,
    generatedAt: options.generatedAt,
    ...(options.prevManifestCid === undefined || options.prevManifestCid === null
      ? {}
      : { prevManifestCid: options.prevManifestCid })
  });

  return signPinManifest(unsigned, soulPrivateKey);
}
