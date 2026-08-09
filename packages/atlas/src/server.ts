#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { ChainView, type ChainSnapshot, type ChainViewOptions } from "./chain-view.js";
import type { AtlasConfig } from "./config.js";
import {
  deriveHead,
  deriveJournals,
  deriveRecordsPage,
  deriveState,
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
    methods: ["GET"]
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

    const page = parseOptionalInt(request.query.page);
    const perPage = parseOptionalInt(request.query.per_page);

    const journalsQuery: JournalsQuery = {};
    if (page !== undefined) {
      journalsQuery.page = page;
    }
    if (perPage !== undefined) {
      journalsQuery.per_page = perPage;
    }

    const sideBlobs = snap.sideBlobs;
    const result =
      sideBlobs === undefined
        ? await deriveJournals(snap.records, snap.verified, journalsQuery)
        : await deriveJournals(snap.records, snap.verified, journalsQuery, {
            getSideBlob: async (cid: string): Promise<Uint8Array> => {
              const bytes = sideBlobs.get(cid);
              if (bytes === undefined) {
                throw new Error(`side blob not found for CID ${cid}`);
              }
              return bytes;
            }
          });
    void reply.send(result);
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

async function main(): Promise<void> {
  const { loadAtlasConfig } = await import("./config.js");
  const config = loadAtlasConfig();
  const app = await createAtlasServer(config);
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
