import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  buildAndSignPinManifestForIpfsDir,
  computeManifestCid,
  decodeBase64Url
} from "@npc/osp-core";

import { writeStdout } from "../io.js";

/** Options for {@link runManifest}. */
export type ManifestOptions = {
  dir: string;
  soulKeyPath?: string;
  generatedAt?: string;
  prevManifestCid?: string;
};

/** Result of a successful manifest build. */
export type ManifestResult = {
  manifestCid: string;
  seq: number;
  headCid: string;
};

/** True when path exists and is a directory. */
function isExistingDirectory(resolvedDir: string): boolean {
  if (!existsSync(resolvedDir)) {
    return false;
  }
  try {
    return statSync(resolvedDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build and soul-sign a pin manifest for an IpfsSoulStore directory.
 *
 * Requires `blocks/`, `seq-index.jsonl`, `HEAD`, and a readable `soul.key`
 * (default `<dir>/soul.key`, override with `--soul-key`).
 */
export async function runManifest(options: ManifestOptions): Promise<ManifestResult> {
  const resolvedDir = path.resolve(options.dir);
  if (!isExistingDirectory(resolvedDir)) {
    throw new Error(`Ipfs soulchain directory not found: ${resolvedDir}`);
  }

  const blocksPath = path.join(resolvedDir, "blocks");
  if (!isExistingDirectory(blocksPath)) {
    throw new Error(`directory is not an IpfsSoulStore layout (missing blocks/): ${resolvedDir}`);
  }

  const soulKeyPath = path.resolve(options.soulKeyPath ?? path.join(resolvedDir, "soul.key"));
  let soulKeyEncoded: string;
  try {
    soulKeyEncoded = (await readFile(soulKeyPath, "utf8")).trim();
  } catch {
    throw new Error(`soul.key not found or unreadable: ${soulKeyPath}`);
  }

  const soulPrivateKey = decodeBase64Url(soulKeyEncoded);
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const manifest = await buildAndSignPinManifestForIpfsDir(resolvedDir, soulPrivateKey, {
    generatedAt,
    ...(options.prevManifestCid === undefined ? {} : { prevManifestCid: options.prevManifestCid })
  });

  const manifestCid = await computeManifestCid(manifest);
  writeStdout(manifestCid);

  return {
    manifestCid,
    seq: manifest.seq,
    headCid: manifest.head
  };
}
