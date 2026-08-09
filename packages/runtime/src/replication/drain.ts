import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  ackReplication,
  buildAndSignPinManifestForIpfsDir,
  computeManifestCid,
  enqueueReplication,
  exportSoulchainCar,
  listPendingReplication,
  listUnackedForTarget,
  type PinManifest,
  type ReplicationEnqueueEntry
} from "@npc/osp-core";
import type { Logger } from "pino";

import type { CarUploadAdapter, FetchImpl } from "./adapters.js";

const LAST_MANIFEST_SEQ_FILE = "last-manifest-seq";
const MANIFEST_CADENCE_SEQ = 500;

/** Handle for the background replication drain loop. */
export type ReplicationDrainHandle = {
  stop: () => Promise<void>;
  tick: () => Promise<void>;
};

/** Options for {@link startReplicationDrain}. */
export type StartReplicationDrainOptions = {
  ipfsDir: string;
  soulPrivateKey: Uint8Array;
  publishedCarPath: string;
  manifestCidPath: string;
  targets: CarUploadAdapter[];
  intervalMs: number;
  logger: Logger;
  now?: () => string;
  fetchImpl?: FetchImpl;
};

/** Parameters shared by manifest cadence helpers. */
export type ManifestCadenceParams = {
  ipfsDir: string;
  soulPrivateKey: Uint8Array;
  publishedCarPath: string;
  manifestCidPath: string;
  now?: () => string;
};

function resolveNow(now?: () => string): string {
  if (now !== undefined) {
    return now();
  }
  return new Date().toISOString();
}

function lastManifestSeqPath(ipfsDir: string): string {
  return path.join(ipfsDir, LAST_MANIFEST_SEQ_FILE);
}

async function readLastManifestSeq(ipfsDir: string): Promise<number> {
  const seqPath = lastManifestSeqPath(ipfsDir);
  if (!existsSync(seqPath)) {
    return -1;
  }

  const raw = await readFile(seqPath, "utf8");
  const trimmed = raw.trim();
  if (trimmed === "") {
    return -1;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return -1;
  }

  return parsed;
}

async function writeLastManifestSeq(ipfsDir: string, seq: number): Promise<void> {
  await writeFile(lastManifestSeqPath(ipfsDir), `${String(seq)}\n`, "utf8");
}

async function readIpfsHeadSeq(ipfsDir: string): Promise<number | null> {
  const headPath = path.join(ipfsDir, "HEAD");
  if (!existsSync(headPath)) {
    return null;
  }

  const raw = await readFile(headPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const seq = Reflect.get(parsed, "seq");
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return null;
  }

  return seq;
}

async function enqueueIfNotPending(ipfsDir: string, entry: ReplicationEnqueueEntry): Promise<void> {
  const pending = await listPendingReplication(ipfsDir);
  const alreadyQueued = pending.some(
    (queued) => queued.cid === entry.cid && queued.kind === entry.kind
  );
  if (!alreadyQueued) {
    await enqueueReplication(ipfsDir, entry);
  }
}

/**
 * Build and sign a pin manifest, export CAR, write manifest CID sidecar, and enqueue manifest/car.
 */
export async function runManifestCadence(params: ManifestCadenceParams): Promise<{
  manifest: PinManifest;
  manifestCid: string;
}> {
  const generatedAt = resolveNow(params.now);
  const manifest = await buildAndSignPinManifestForIpfsDir(params.ipfsDir, params.soulPrivateKey, {
    generatedAt
  });
  const manifestCid = await computeManifestCid(manifest);

  const publishedDir = path.dirname(params.publishedCarPath);
  await mkdir(publishedDir, { recursive: true });

  await exportSoulchainCar({
    ipfsDir: params.ipfsDir,
    manifest,
    outPath: params.publishedCarPath
  });

  await writeFile(params.manifestCidPath, `${manifestCid}\n`, "utf8");

  const enqueuedAt = generatedAt;
  try {
    await enqueueIfNotPending(params.ipfsDir, {
      cid: manifestCid,
      kind: "manifest",
      enqueued_at: enqueuedAt
    });
    await enqueueIfNotPending(params.ipfsDir, {
      cid: manifestCid,
      kind: "car",
      enqueued_at: enqueuedAt
    });
  } catch {
    // Enqueue failures must not fail cadence (append path is authoritative).
  }

  const headSeq = await readIpfsHeadSeq(params.ipfsDir);
  if (headSeq !== null) {
    await writeLastManifestSeq(params.ipfsDir, headSeq);
  }

  return { manifest, manifestCid };
}

/**
 * Run manifest cadence enqueue after departure (drain tick also handles periodic cadence).
 */
export async function notifyDepartureForReplication(params: ManifestCadenceParams): Promise<void> {
  await runManifestCadence(params);
}

async function targetHasUnacked(ipfsDir: string, targetName: string): Promise<boolean> {
  const pending = await listUnackedForTarget(ipfsDir, targetName);
  return pending.length > 0;
}

async function anyTargetHasUnacked(ipfsDir: string, targets: CarUploadAdapter[]): Promise<boolean> {
  for (const target of targets) {
    if (await targetHasUnacked(ipfsDir, target.name)) {
      return true;
    }
  }
  return false;
}

/**
 * Start a periodic replication drain that uploads CARs to configured targets.
 *
 * When targets are empty the drain is a no-op. Upload failures are logged and retried
 * on the next tick without affecting append.
 */
export function startReplicationDrain(
  options: StartReplicationDrainOptions
): ReplicationDrainHandle {
  const now = options.now ?? ((): string => new Date().toISOString());
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let inFlight: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    if (options.targets.length === 0) {
      return;
    }

    if (ticking) {
      return;
    }
    ticking = true;

    try {
      const headSeq = await readIpfsHeadSeq(options.ipfsDir);
      if (headSeq === null) {
        return;
      }

      const lastManifestSeq = await readLastManifestSeq(options.ipfsDir);
      const cadenceDue = headSeq - lastManifestSeq >= MANIFEST_CADENCE_SEQ;
      const unacked = await anyTargetHasUnacked(options.ipfsDir, options.targets);

      if (!cadenceDue && !unacked) {
        return;
      }

      const { manifestCid } = await runManifestCadence({
        ipfsDir: options.ipfsDir,
        soulPrivateKey: options.soulPrivateKey,
        publishedCarPath: options.publishedCarPath,
        manifestCidPath: options.manifestCidPath,
        now
      });

      const carBytes = await readFile(options.publishedCarPath);
      const carUint8 = new Uint8Array(carBytes);

      for (const adapter of options.targets) {
        const pending = await listUnackedForTarget(options.ipfsDir, adapter.name);
        if (pending.length === 0) {
          continue;
        }

        try {
          await adapter.uploadCar(carUint8, manifestCid);
          const at = now();
          for (const entry of pending) {
            await ackReplication(options.ipfsDir, {
              acked: entry.cid,
              target: adapter.name,
              at
            });
          }
          options.logger.info({ queueDepth: 0, target: adapter.name }, "replication_upload_ok");
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          options.logger.warn(
            { err: message, queueDepth: pending.length, target: adapter.name },
            "replication_upload_failed"
          );
        }
      }
    } finally {
      ticking = false;
    }
  };

  const tickWrapped = (): void => {
    inFlight = tick().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.error({ err: message }, "replication_drain_tick_error");
    });
  };

  intervalId = setInterval(tickWrapped, options.intervalMs);

  return {
    tick: async (): Promise<void> => {
      await tick();
    },
    stop: async (): Promise<void> => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      if (inFlight !== undefined) {
        await inFlight;
      }
    }
  };
}
