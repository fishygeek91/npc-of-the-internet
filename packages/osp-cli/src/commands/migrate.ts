import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  EncodingError,
  FileSoulStore,
  OSP_SPEC_V01,
  OSP_SPEC_V02,
  StorageError,
  decodeBase64Url,
  migrateChainToV02,
  parseDoorPrivateKeyMap,
  parseDoorPublicKeyMap,
  publicKeyFromPrivate,
  type OspRecord
} from "@npc/osp-core";

import { writeStdout } from "../io.js";

/** Options for {@link runMigrate}. */
export type MigrateOptions = {
  dir: string;
  /** Target spec; only `osp/0.2` is supported. */
  to: string;
  /** `doorId=base64url` Door private keys for re-cosigning. */
  doorPrivateKeys?: readonly string[];
  /** Optional Door public keys for post-migrate verify. */
  doorPublicKeys?: readonly string[];
};

/** Result printed after a successful migrate. */
export type MigrateResult = {
  backupDir: string;
  recordCount: number;
  blobCount: number;
  headCid: string;
};

/**
 * Migrate a local FileSoulStore chain from osp/0.1 to osp/0.2 in place.
 *
 * Writes the migrated chain to a sibling temp directory, moves the original
 * directory to `*.pre-osp-0.2-<timestamp>`, then renames the temp dir into place.
 * Soul key is copied unchanged; record CIDs change (whole-chain re-sign).
 */
export async function runMigrate(options: MigrateOptions): Promise<MigrateResult> {
  if (options.to !== OSP_SPEC_V02) {
    throw new Error(
      `unsupported migrate target "${options.to}" (only ${OSP_SPEC_V02} is supported)`
    );
  }

  const sourceDir = path.resolve(options.dir);
  const soulKeyPath = path.join(sourceDir, "soul.key");
  if (!existsSync(soulKeyPath)) {
    throw new Error(`soul.key not found at ${soulKeyPath}`);
  }
  if (!existsSync(path.join(sourceDir, "chain.jsonl"))) {
    throw new Error(`chain.jsonl not found under ${sourceDir}`);
  }

  const soulPrivateKey = decodeBase64Url((await readFile(soulKeyPath, "utf8")).trim());
  if (soulPrivateKey.length !== 32) {
    throw new EncodingError(
      `soul.key must decode to 32 bytes, got ${String(soulPrivateKey.length)}`
    );
  }

  let doorPrivateKeys: Record<string, Uint8Array> = {};
  if (options.doorPrivateKeys !== undefined && options.doorPrivateKeys.length > 0) {
    doorPrivateKeys = parseDoorPrivateKeyMap(options.doorPrivateKeys);
  }

  const doorPublicKeys: Record<string, Uint8Array> = {};
  if (options.doorPublicKeys !== undefined && options.doorPublicKeys.length > 0) {
    Object.assign(doorPublicKeys, parseDoorPublicKeyMap(options.doorPublicKeys));
  }
  for (const [doorId, privateKey] of Object.entries(doorPrivateKeys)) {
    doorPublicKeys[doorId] = publicKeyFromPrivate(privateKey);
  }
  const doorPublicKeysOption =
    Object.keys(doorPublicKeys).length === 0 ? undefined : { doorPublicKeys };

  const sourceStore = await FileSoulStore.openReadOnly(sourceDir, doorPublicKeysOption);
  const records: OspRecord[] = [];
  try {
    for await (const record of sourceStore.iterate()) {
      records.push(record);
    }
    const verification = sourceStore.verification();
    if (!verification.valid) {
      throw new StorageError(
        `refusing to migrate: source chain does not verify (${String(verification.failures.length)} failure(s))`
      );
    }
  } finally {
    await sourceStore.close();
  }

  if (records.length === 0) {
    throw new StorageError("refusing to migrate: empty chain");
  }
  if (records[0]?.spec === OSP_SPEC_V02) {
    throw new StorageError(`chain is already ${OSP_SPEC_V02}; nothing to migrate`);
  }
  if (records[0]?.spec !== OSP_SPEC_V01) {
    throw new StorageError(
      `refusing to migrate: unsupported source spec ${String(records[0]?.spec)}`
    );
  }

  const migrated = await migrateChainToV02({
    records,
    soulPrivateKey,
    doorPrivateKeys
  });

  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const backupDir = `${sourceDir}.pre-osp-0.2-${stamp}`;
  const tempDir = `${sourceDir}.migrating-${stamp}`;

  if (existsSync(tempDir)) {
    throw new Error(`refusing to migrate: temp directory already exists at ${tempDir}`);
  }
  if (existsSync(backupDir)) {
    throw new Error(`refusing to migrate: backup directory already exists at ${backupDir}`);
  }

  mkdirSync(tempDir, { recursive: true });
  await copyFile(soulKeyPath, path.join(tempDir, "soul.key"));

  const destStore = await FileSoulStore.open(tempDir, doorPublicKeysOption);
  try {
    for (const [cid, bytes] of migrated.blobs) {
      const put = await destStore.putSideBlob(bytes);
      if (put.cid !== cid) {
        throw new StorageError(`side-blob CID mismatch during migrate: ${put.cid} vs ${cid}`);
      }
    }
    for (const record of migrated.records) {
      await destStore.append(record);
    }
    const verification = destStore.verification();
    if (!verification.valid) {
      throw new StorageError(
        `migrated chain failed verify (${String(verification.failures.length)} failure(s)); aborting swap`
      );
    }
  } catch (error) {
    await destStore.close();
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  await destStore.close();

  renameSync(sourceDir, backupDir);
  try {
    renameSync(tempDir, sourceDir);
  } catch (error) {
    // Best-effort restore of the pre-migration directory name.
    try {
      renameSync(backupDir, sourceDir);
    } catch {
      // Leave both paths for operator recovery.
    }
    throw error;
  }

  const headCid = [...migrated.cidMap.values()].at(-1);
  if (headCid === undefined) {
    throw new StorageError("migrate produced empty cid map");
  }

  writeStdout(`Migrated ${String(migrated.records.length)} records to ${OSP_SPEC_V02}`);
  writeStdout(`Side blobs: ${String(migrated.blobs.size)}`);
  writeStdout(`Backup: ${backupDir}`);
  writeStdout(`Head CID: ${headCid}`);

  return {
    backupDir,
    recordCount: migrated.records.length,
    blobCount: migrated.blobs.size,
    headCid
  };
}
