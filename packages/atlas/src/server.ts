#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { ChainView, type ChainSnapshot, type ChainViewOptions } from "./chain-view.js";
import type { AtlasConfig } from "./config.js";
import {
  deriveHead,
  deriveJournals,
  deriveRecordsPage,
  deriveState,
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

  app.get("/journals", async (_request, reply) => {
    const snap = await chainView.snapshot();
    if (replyIfUnreadable(snap, reply)) {
      return;
    }

    const result = await deriveJournals(snap.records, snap.verified);
    void reply.send(result);
  });

  return app;
}

/** Send a 503 when the snapshot is structurally unreadable; returns true if handled. */
function replyIfUnreadable(snap: ChainSnapshot, reply: FastifyReply): boolean {
  if (snap.unreadable !== true) {
    return false;
  }
  void reply
    .status(503)
    .send(
      atlasErrorToBody(
        new AtlasError("chain_unreadable", snap.unreadableMessage ?? "chain is unreadable", 503)
      )
    );
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
