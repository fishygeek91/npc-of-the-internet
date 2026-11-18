#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import cors from "@fastify/cors";
import type { Cid } from "@npc/osp-core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { ChainView, type ChainSnapshot, type ChainViewOptions } from "./chain-view.js";
import type { AtlasConfig } from "./config.js";
import {
  buildChainExport,
  chainExportEtag,
  EXPORT_AFTER_UNKNOWN_CODE,
  headerSingle,
  ifNoneMatchSatisfied,
  indexOfExportedRecord,
  parseChainExportAfter,
  type ChainExportBody
} from "./export-chain.js";
import {
  deriveHead,
  deriveJournals,
  deriveRecordsPage,
  deriveResidencies,
  deriveState,
  type DeriveJournalsOptions,
  type JournalsQuery,
  type RecordsQuery
} from "./derive.js";
import { AtlasError, atlasErrorToBody } from "./errors.js";

/**
 * Create a Fastify instance serving the Atlas read-only chain API.
 * Does not listen; callers use `listen` or `inject` in tests.
 */
export async function createAtlasServer(config: AtlasConfig): Promise<FastifyInstance> {
  const chainViewOptions: ChainViewOptions = { chainDir: config.chainDir };
  if (config.doorPublicKeys !== undefined) {
    chainViewOptions.doorPublicKeys = config.doorPublicKeys;
  }
  const chainView = new ChainView(chainViewOptions);

  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true,
    methods: ["GET"],
    // Browsers on another origin must be able to read ETag for If-None-Match.
    exposedHeaders: ["ETag"]
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AtlasError) {
      void reply.status(error.statusCode).send(atlasErrorToBody(error));
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`atlas internal_error: ${detail}\n`);
    void reply
      .status(500)
      .send(atlasErrorToBody(new AtlasError("internal_error", "Internal server error", 500)));
  });

  app.addHook("onClose", async () => {
    await chainView.close();
  });

  app.get("/state", async (_request, reply) => {
    const snap = await chainView.snapshot();
    if (replyIfUnreadable(snap, reply)) {
      return;
    }
    void reply.send(deriveState(snap.records, snap.verified));
  });

  app.get("/chain/export", async (request, reply) => {
    // Validate `after` before the snapshot so a bad cursor never reaches the chain.
    const after = parseChainExportAfter(request.query);
    const snap = await chainView.snapshot();
    if (replyIfUnreadable(snap, reply)) {
      return;
    }

    const records = await recordsForExport(snap, after);
    const exported = cachedChainExport(snap, config.doorPublicKeys, after, records);
    void reply.header("ETag", exported.etag).header("Cache-Control", "no-cache");
    if (ifNoneMatchSatisfied(headerSingle(request.headers["if-none-match"]), exported.etag)) {
      void reply.code(304).send();
      return;
    }
    void reply.send(exported.body);
  });

  app.get("/chain/head", async (_request, reply) => {
    const snap = await chainView.snapshot();
    if (replyIfUnreadable(snap, reply)) {
      return;
    }

    const head = await deriveHead(snap.records, snap.verified);
    if (head === null) {
      void reply
        .status(404)
        .send(atlasErrorToBody(new AtlasError("chain_empty", "chain has no records", 404)));
      return;
    }

    void reply.send(head);
  });

  app.get<{
    Querystring: { type?: string; page?: string; per_page?: string };
  }>("/records", async (request, reply) => {
    const snap = await chainView.snapshot();
    if (replyIfUnreadable(snap, reply)) {
      return;
    }

    const page = parseOptionalInt(request.query.page);
    const perPage = parseOptionalInt(request.query.per_page);

    const recordsQuery: RecordsQuery = {};
    if (request.query.type !== undefined) {
      recordsQuery.type = request.query.type;
    }
    if (page !== undefined) {
      recordsQuery.page = page;
    }
    if (perPage !== undefined) {
      recordsQuery.per_page = perPage;
    }

    const result = await deriveRecordsPage(snap.records, snap.verified, recordsQuery);
    void reply.send(result);
  });

  app.get<{
    Querystring: { page?: string; per_page?: string };
  }>("/journals", async (request, reply) => {
    const snap = await chainView.snapshot();
    if (replyIfUnreadable(snap, reply)) {
      return;
    }
    const query = parsePageQuery(request.query);
    void reply.send(
      await deriveJournals(snap.records, snap.verified, query, sideBlobOptions(snap))
    );
  });

  app.get<{
    Querystring: { page?: string; per_page?: string };
  }>("/residencies", async (request, reply) => {
    const snap = await chainView.snapshot();
    if (replyIfUnreadable(snap, reply)) {
      return;
    }
    const query = parsePageQuery(request.query);
    void reply.send(
      await deriveResidencies(snap.records, snap.verified, query, sideBlobOptions(snap))
    );
  });

  if (config.publishedCarPath !== undefined) {
    const carPath = config.publishedCarPath;
    app.get("/soulchain-latest.car", async (_request, reply) => {
      if (!existsSync(carPath)) {
        void reply
          .status(404)
          .send(
            atlasErrorToBody(
              new AtlasError("car_not_found", "published soulchain CAR file is not available", 404)
            )
          );
        return;
      }

      // Stream the CAR — avoid buffering the whole file per request as chains grow.
      // Return the send() promise so inject/light-my-request drains the stream.
      return reply
        .header("Content-Type", "application/vnd.ipld.car")
        .send(createReadStream(carPath));
    });
  }

  if (config.manifestCidPath !== undefined) {
    const manifestPath = config.manifestCidPath;
    app.get("/soulchain/manifest", async (_request, reply) => {
      if (!existsSync(manifestPath)) {
        void reply
          .status(404)
          .send(
            atlasErrorToBody(
              new AtlasError("manifest_not_found", "published manifest CID is not available", 404)
            )
          );
        return;
      }

      const raw = await readFile(manifestPath, "utf8");
      const manifestCid = raw.trim();
      if (manifestCid === "") {
        void reply
          .status(404)
          .send(
            atlasErrorToBody(
              new AtlasError("manifest_not_found", "published manifest CID is not available", 404)
            )
          );
        return;
      }

      void reply.send({ manifestCid });
    });
  }

  return app;
}

/** Send a 503 when the snapshot is structurally unreadable; returns true if handled. */
function replyIfUnreadable(snap: ChainSnapshot, reply: FastifyReply): boolean {
  if (snap.unreadable !== true) {
    return false;
  }
  const detail = snap.unreadableMessage ?? "chain is unreadable";
  process.stderr.write(`atlas chain_unreadable: ${detail}\n`);
  void reply
    .status(503)
    .send(atlasErrorToBody(new AtlasError("chain_unreadable", "chain is unreadable", 503)));
  return true;
}

type CachedExport = {
  body: ChainExportBody;
  etag: string;
};

/**
 * Encoded bodies and `ETag`s for one snapshot. The full export is keyed by
 * `""`; each tail is keyed by its `after` CID. `ChainView` returns the same
 * snapshot object until the chain file changes, so a `304` does not rebuild
 * the body. Door keys are the process config and do not change under a live snapshot.
 */
const chainExportCache = new WeakMap<ChainSnapshot, Map<string, CachedExport>>();

function cachedChainExport(
  snapshot: ChainSnapshot,
  doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined,
  after: Cid | undefined,
  records: ChainSnapshot["records"]
): CachedExport {
  const key = after ?? "";
  let byCursor = chainExportCache.get(snapshot);
  if (byCursor === undefined) {
    byCursor = new Map();
    chainExportCache.set(snapshot, byCursor);
  }
  const hit = byCursor.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const body = buildChainExport(snapshot, doorPublicKeys, records);
  const entry = {
    body,
    etag: after === undefined ? chainExportEtag(body) : chainExportEtag(body, after)
  };
  byCursor.set(key, entry);
  return entry;
}

/**
 * Records for this export. No `after` is the full chain. A known CID returns
 * the records strictly after it (the head's tail is empty). An unknown CID
 * is {@link EXPORT_AFTER_UNKNOWN_CODE}.
 *
 * @throws {AtlasError} 404 `export_after_unknown` when `after` is not on the chain.
 */
async function recordsForExport(
  snap: ChainSnapshot,
  after: Cid | undefined
): Promise<ChainSnapshot["records"]> {
  if (after === undefined) {
    return snap.records;
  }
  const index = await indexOfExportedRecord(snap.records, after);
  if (index === undefined) {
    throw new AtlasError(EXPORT_AFTER_UNKNOWN_CODE, "after is not a record on this chain", 404);
  }
  return snap.records.slice(index + 1);
}

/** Parse `page` / `per_page` query strings for paginated journal-style routes. */
function parsePageQuery(query: { page?: string; per_page?: string }): JournalsQuery {
  const page = parseOptionalInt(query.page);
  const perPage = parseOptionalInt(query.per_page);
  const parsed: JournalsQuery = {};
  if (page !== undefined) {
    parsed.page = page;
  }
  if (perPage !== undefined) {
    parsed.per_page = perPage;
  }
  return parsed;
}

/** Journal blob resolver backed by the snapshot's eagerly loaded side blobs. */
function sideBlobOptions(snap: ChainSnapshot): DeriveJournalsOptions {
  const sideBlobs = snap.sideBlobs;
  if (sideBlobs === undefined) {
    return {};
  }
  return {
    getSideBlob: async (cid: string): Promise<Uint8Array> => {
      const bytes = sideBlobs.get(cid);
      if (bytes === undefined) {
        throw new Error(`side blob not found for CID ${cid}`);
      }
      return bytes;
    }
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^-?\d+$/.test(value)) {
    throw new AtlasError("invalid_request", `Invalid integer query parameter: ${value}`, 400);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new AtlasError("invalid_request", `Invalid integer query parameter: ${value}`, 400);
  }
  return parsed;
}

/** Minimal process surface used by {@link registerShutdownSignals} (injectable for tests). */
export type ShutdownProcess = {
  once(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code?: number): never;
};

/**
 * Close the server and exit on SIGTERM/SIGINT.
 *
 * Node as container PID 1 has no default SIGTERM handler, so without this
 * `docker stop` waits out the grace period and SIGKILLs. Exits 0 after
 * `app.close()` resolves, 1 if closing fails; repeated signals are ignored.
 */
export function registerShutdownSignals(
  app: FastifyInstance,
  proc: ShutdownProcess = process,
  signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"]
): void {
  let closing = false;
  const onSignal = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void app.close().then(
      () => proc.exit(0),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`atlas shutdown_failed: ${message}\n`);
        proc.exit(1);
      }
    );
  };
  for (const signal of signals) {
    proc.once(signal, onSignal);
  }
}

async function main(): Promise<void> {
  const { loadAtlasConfig } = await import("./config.js");
  const config = loadAtlasConfig();
  const app = await createAtlasServer(config);
  registerShutdownSignals(app);
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
