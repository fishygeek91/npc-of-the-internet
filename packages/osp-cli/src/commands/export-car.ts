import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  buildAndSignPinManifestForIpfsDir,
  computeManifestCid,
  decodeBase64Url,
  exportSoulchainCar
} from "@npc/osp-core";

import { writeStdout } from "../io.js";

/** Options for {@link runExportCar}. */
export type ExportCarOptions = {
  dir: string;
  out: string;
  soulKeyPath?: string;
  generatedAt?: string;
  prevManifestCid?: string;
};

/** Result of a successful CAR export. */
export type ExportCarResult = {
  manifestCid: string;
  outPath: string;
  seq: number;
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
 * Build/sign a pin manifest and write a CARv1 file rooted at the manifest CID.
 *
 * Requires an IpfsSoulStore on-disk layout (`blocks/`, seq-index, HEAD) and soul.key.
 */
export async function runExportCar(options: ExportCarOptions): Promise<ExportCarResult> {
  const resolvedDir = path.resolve(options.dir);
  if (!isExistingDirectory(resolvedDir)) {
    throw new Error(`Ipfs soulchain directory not found: ${resolvedDir}`);
  }

  const blocksPath = path.join(resolvedDir, "blocks");
  if (!isExistingDirectory(blocksPath)) {
    throw new Error(`directory is not an IpfsSoulStore layout (missing blocks/): ${resolvedDir}`);
  }

  if (options.out.trim().length === 0) {
    throw new Error("export-car requires a non-empty --out path");
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

  const outPath = path.resolve(options.out);
  await exportSoulchainCar({
    ipfsDir: resolvedDir,
    manifest,
    outPath
  });

  const manifestCid = await computeManifestCid(manifest);
  writeStdout(`Manifest CID: ${manifestCid}`);
  writeStdout(`CAR: ${outPath}`);

  return {
    manifestCid,
    outPath,
    seq: manifest.seq
  };
}
