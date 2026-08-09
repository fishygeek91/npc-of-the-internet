import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { CarReader, CarWriter } from "@ipld/car";
import { FsBlockstore } from "blockstore-fs";
import { NextToLast } from "blockstore-fs/sharding";
import { CID } from "multiformats/cid";

import { computeCidFromCanonicalBytes } from "../crypto/cid.js";
import { decodePublicKey } from "../encoding/base64url.js";
import { CorruptionError, EncodingError, SchemaError, StorageError } from "../errors.js";
import {
  computeManifestCid,
  decodePinManifest,
  encodePinManifest,
  verifyPinManifest,
  type PinManifest
} from "../manifest/pin-manifest.js";
import { RecordSchema } from "../schemas/index.js";
import { writeHeadAtomic } from "../store/head-file.js";
import { bytesEqual, fsyncDirectory, fsyncPath, writeAllSync } from "../store/fsync.js";
import { resolveBlockPath } from "../store/ipfs-soul-store.js";
import { nodeErrorMessage } from "../store/node-fs-error.js";

const BLOCKS_DIR = "blocks";
const SEQ_INDEX_FILE = "seq-index.jsonl";

/** Input to {@link exportSoulchainCar}. */
export type ExportSoulchainCarInput = {
  ipfsDir: string;
  manifest: PinManifest;
  outPath: string;
};

/** Input to {@link importSoulchainCar}. */
export type ImportSoulchainCarInput = {
  carPathOrBytes: string | Uint8Array;
  outDir: string;
};

/** Result of {@link importSoulchainCar}. */
export type ImportSoulchainCarResult = {
  manifestCid: string;
  headCid: string;
  seq: number;
};

/**
 * Export a signed pin manifest and all referenced record blocks to a CARv1 file.
 *
 * Record bytes are read opaquely from `blocks/` — never re-encoded.
 */
export async function exportSoulchainCar(input: ExportSoulchainCarInput): Promise<void> {
  const ipfsDir = path.resolve(input.ipfsDir);
  const blocksPath = path.join(ipfsDir, BLOCKS_DIR);
  const manifestBytes = encodePinManifest(input.manifest);
  const manifestCid = await computeManifestCid(input.manifest);
  const manifestCidParsed = CID.parse(manifestCid);

  const { writer, out } = CarWriter.create([manifestCidParsed]);
  const carParts: Uint8Array[] = [];
  const drainOut = (async () => {
    for await (const part of out) {
      carParts.push(part);
    }
  })();

  await writer.put({ cid: manifestCidParsed, bytes: manifestBytes });

  for (const recordCid of input.manifest.records) {
    const blockPath = resolveBlockPath(blocksPath, recordCid);
    let recordBytes: Buffer;
    try {
      recordBytes = await readFile(blockPath);
    } catch (error) {
      throw new StorageError(
        `failed to read record block ${recordCid}: ${nodeErrorMessage(error)}`
      );
    }

    const computedCid = await computeCidFromCanonicalBytes(recordBytes);
    if (computedCid !== recordCid) {
      throw new CorruptionError(
        `record block CID mismatch for ${recordCid}: computed ${computedCid}`
      );
    }

    await writer.put({ cid: CID.parse(recordCid), bytes: recordBytes });
  }

  await writer.close();
  await drainOut;

  let total = 0;
  for (const part of carParts) {
    total += part.length;
  }
  const carBytes = new Uint8Array(total);
  let offset = 0;
  for (const part of carParts) {
    carBytes.set(part, offset);
    offset += part.length;
  }

  await writeFile(path.resolve(input.outPath), carBytes);
}

/** Put one block into FsBlockstore with the same durable fsync pattern as IpfsSoulStore. */
async function putBlockDurable(
  blockstore: FsBlockstore,
  blocksPath: string,
  shard: NextToLast,
  cid: string,
  bytes: Uint8Array
): Promise<void> {
  const parsedCid = CID.parse(cid);

  if (await blockstore.has(parsedCid)) {
    const existingParts: Uint8Array[] = [];
    for await (const part of blockstore.get(parsedCid)) {
      existingParts.push(part);
    }
    let total = 0;
    for (const part of existingParts) {
      total += part.length;
    }
    const existing = new Uint8Array(total);
    let offset = 0;
    for (const part of existingParts) {
      existing.set(part, offset);
      offset += part.length;
    }
    if (!bytesEqual(existing, bytes)) {
      throw new CorruptionError(`block already exists for CID ${cid} with different bytes`);
    }
    return;
  }

  await blockstore.put(parsedCid, bytes);
  const blockPath = resolveBlockPath(blocksPath, cid, shard);
  await fsyncPath(blockPath);
  await fsyncDirectory(path.dirname(blockPath));
  await fsyncDirectory(blocksPath);
}

/** Write seq-index.jsonl atomically with fsync. */
async function writeSeqIndexAtomic(dir: string, recordCids: readonly string[]): Promise<void> {
  const indexPath = path.join(dir, SEQ_INDEX_FILE);
  const lines = recordCids.map((cid, seq) => `${JSON.stringify({ seq, cid })}\n`).join("");
  const payload = new TextEncoder().encode(lines);

  let fd: number;
  try {
    fd = openSync(indexPath, "w");
  } catch (error) {
    throw new StorageError(`failed to create seq-index: ${nodeErrorMessage(error)}`);
  }

  try {
    writeAllSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  await fsyncPath(indexPath);
  await fsyncDirectory(dir);
}

/**
 * Import a soulchain CAR into a fresh IpfsSoulStore on-disk layout.
 */
export async function importSoulchainCar(
  input: ImportSoulchainCarInput
): Promise<ImportSoulchainCarResult> {
  let carBytes: Uint8Array;
  if (typeof input.carPathOrBytes === "string") {
    try {
      carBytes = await readFile(path.resolve(input.carPathOrBytes));
    } catch (error) {
      throw new StorageError(`failed to read CAR file: ${nodeErrorMessage(error)}`);
    }
  } else {
    carBytes = input.carPathOrBytes;
  }

  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  if (roots.length === 0) {
    throw new CorruptionError("CAR has no roots");
  }

  const manifestRoot = roots[0];
  if (manifestRoot === undefined) {
    throw new CorruptionError("CAR root is missing");
  }

  const manifestBlock = await reader.get(manifestRoot);
  if (manifestBlock === undefined) {
    throw new CorruptionError(`manifest block missing for root CID ${manifestRoot.toString()}`);
  }

  const manifestCid = manifestRoot.toString();
  const computedManifestCid = await computeCidFromCanonicalBytes(manifestBlock.bytes);
  if (computedManifestCid !== manifestCid) {
    throw new CorruptionError(
      `manifest block CID mismatch: expected ${manifestCid}, computed ${computedManifestCid}`
    );
  }

  let manifest: PinManifest;
  try {
    manifest = decodePinManifest(manifestBlock.bytes);
  } catch (error) {
    if (error instanceof SchemaError || error instanceof EncodingError) {
      throw new CorruptionError(`invalid manifest block: ${error.message}`);
    }
    throw error;
  }

  const genesisBlock = await reader.get(CID.parse(manifest.genesis));
  if (genesisBlock === undefined) {
    throw new CorruptionError(`genesis block missing for CID ${manifest.genesis}`);
  }

  const genesisComputedCid = await computeCidFromCanonicalBytes(genesisBlock.bytes);
  if (genesisComputedCid !== manifest.genesis) {
    throw new CorruptionError(
      `genesis block CID mismatch: expected ${manifest.genesis}, computed ${genesisComputedCid}`
    );
  }

  let genesisParsed: unknown;
  try {
    genesisParsed = JSON.parse(new TextDecoder().decode(genesisBlock.bytes));
  } catch (error) {
    throw new CorruptionError(`invalid genesis JSON: ${nodeErrorMessage(error)}`);
  }

  const genesisSchema = RecordSchema.safeParse(genesisParsed);
  if (!genesisSchema.success) {
    throw new CorruptionError(`invalid genesis record: ${genesisSchema.error.message}`);
  }
  if (genesisSchema.data.type !== "genesis" || genesisSchema.data.seq !== 0) {
    throw new CorruptionError("genesis record must be type genesis at seq 0");
  }

  const soulPublicKey = decodePublicKey(genesisSchema.data.body.soul_pubkey);
  await verifyPinManifest(manifest, soulPublicKey);

  const outDir = path.resolve(input.outDir);
  const blocksPath = path.join(outDir, BLOCKS_DIR);

  if (existsSync(blocksPath)) {
    throw new StorageError(`import target already has blocks directory: ${blocksPath}`);
  }
  if (existsSync(path.join(outDir, SEQ_INDEX_FILE))) {
    throw new StorageError(
      `import target already has seq-index: ${path.join(outDir, SEQ_INDEX_FILE)}`
    );
  }

  await mkdir(outDir, { recursive: true });
  await mkdir(blocksPath, { recursive: true });
  await fsyncDirectory(outDir);
  await fsyncDirectory(blocksPath);

  const shard = new NextToLast();
  const blockstore = new FsBlockstore(blocksPath, {
    shardingStrategy: shard,
    createIfMissing: true
  });
  await blockstore.open();

  try {
    for (const recordCid of manifest.records) {
      const recordBlock = await reader.get(CID.parse(recordCid));
      if (recordBlock === undefined) {
        throw new CorruptionError(`record block missing for CID ${recordCid}`);
      }

      const recordComputedCid = await computeCidFromCanonicalBytes(recordBlock.bytes);
      if (recordComputedCid !== recordCid) {
        throw new CorruptionError(
          `record block CID mismatch for ${recordCid}: computed ${recordComputedCid}`
        );
      }

      await putBlockDurable(blockstore, blocksPath, shard, recordCid, recordBlock.bytes);
    }

    await writeSeqIndexAtomic(outDir, manifest.records);
    await writeHeadAtomic(outDir, { cid: manifest.head, seq: manifest.seq });
  } finally {
    await blockstore.close();
  }

  return {
    manifestCid,
    headCid: manifest.head,
    seq: manifest.seq
  };
}
