import { ChainVerifier } from "@npc/osp-core/browser";

import {
  feedVerifier,
  type WorkerVerifyReply,
  type WorkerVerifyRequest
} from "./incremental-chain.js";

type WorkerHost = {
  postMessage(message: WorkerVerifyReply): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

const state: { verifier: ChainVerifier | null } = { verifier: null };

/**
 * True when `host` is a dedicated worker (no document, `importScripts` present).
 * The classic bundle runs this check so the same file can be the page and the worker.
 */
export function isDedicatedWorker(host: unknown): host is WorkerHost {
  if (typeof host !== "object" || host === null) {
    return false;
  }
  if ("document" in host && host.document !== undefined && host.document !== null) {
    return false;
  }
  if (!("importScripts" in host) || typeof host.importScripts !== "function") {
    return false;
  }
  if (!("postMessage" in host) || typeof host.postMessage !== "function") {
    return false;
  }
  return true;
}

/**
 * Keep one {@link ChainVerifier} in this worker and admit each posted batch.
 * `reset` drops the previous prefix. A failed batch drops the verifier.
 */
export function installChainWorker(host: unknown): void {
  if (!isDedicatedWorker(host)) {
    return;
  }
  host.onmessage = (event) => {
    void handleWorkerMessage(host, event.data);
  };
}

async function handleWorkerMessage(host: WorkerHost, data: unknown): Promise<void> {
  const request = readRequest(data);
  if (request === null) {
    postReply(host, { id: 0, ok: false, fed: 0, head: null });
    return;
  }
  try {
    if (!request.reset && state.verifier === null) {
      postReply(host, { id: request.id, ok: false, fed: 0, head: null });
      return;
    }
    if (request.reset || state.verifier === null) {
      state.verifier = new ChainVerifier({ doorPublicKeys: request.doorPublicKeys });
    }
    const verifier = state.verifier;
    if (verifier === null) {
      postReply(host, { id: request.id, ok: false, fed: 0, head: null });
      return;
    }
    const fed = await feedVerifier(verifier, request.records, null);
    if (!fed.ok) {
      state.verifier = null;
      postReply(host, { id: request.id, ok: false, fed: fed.fed, head: null });
      return;
    }
    postReply(host, { id: request.id, ok: true, fed: fed.fed, head: fed.head });
  } catch {
    state.verifier = null;
    postReply(host, { id: request.id, ok: false, fed: 0, head: null });
  }
}

function postReply(host: WorkerHost, reply: WorkerVerifyReply): void {
  host.postMessage(reply);
}

function readRequest(value: unknown): WorkerVerifyRequest | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (
    !("id" in value) ||
    !("reset" in value) ||
    !("records" in value) ||
    !("doorPublicKeys" in value)
  ) {
    return null;
  }
  if (
    typeof value.id !== "number" ||
    typeof value.reset !== "boolean" ||
    !Array.isArray(value.records)
  ) {
    return null;
  }
  if (!isKeyMap(value.doorPublicKeys)) {
    return null;
  }
  return {
    id: value.id,
    reset: value.reset,
    records: value.records,
    doorPublicKeys: value.doorPublicKeys
  };
}

function isKeyMap(value: unknown): value is Record<string, Uint8Array> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => entry instanceof Uint8Array);
}
