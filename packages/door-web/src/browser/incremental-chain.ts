import {
  ChainVerifier,
  decodePublicKey,
  type OspRecord,
  type VerifyChainOptions
} from "@npc/osp-core/browser";

/**
 * Main-thread budget for one chunk of {@link feedVerifier}.
 * The next chunk starts only after {@link VerifyClock.yield} resolves.
 */
export const CHAIN_VERIFY_CHUNK_MS = 50;

/** Atlas 404 `error.code` for an `after` CID that is not on the chain. */
const EXPORT_AFTER_UNKNOWN = "export_after_unknown";

const DOOR_ID_RE = /^[a-z0-9-]+:[A-Za-z0-9_-]+$/u;

/** Clock and yield used to keep a chunked verify under {@link CHAIN_VERIFY_CHUNK_MS}. */
export type VerifyClock = {
  now: () => number;
  yield: () => Promise<void>;
};

/** `fetch` wrapper. Call it as a function, not as a method on a bag of hooks. */
export type PageFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Page operations for one verify. Every function is invoked with no receiver
 * so a browser global is not called as a method on this object.
 */
export type VerifyHooks = {
  fetch: PageFetch;
  now: () => number;
  yield: () => Promise<void>;
  createVerifier: (options: VerifyChainOptions) => ChainVerifier;
};

/** Door keys ready for `ChainVerifier`, plus a stable signature for later tails. */
export type PreparedKeys = {
  decoded: Record<string, Uint8Array>;
  signature: string;
};

/**
 * One page's chain. The verifier lives here. A refetch feeds only the new records.
 */
export type ExportClient = {
  etag: string | null;
  /** `etag` belongs to this `after` cursor. Null is the full export URL. */
  etagAfter: string | null;
  records: OspRecord[];
  blobs: Record<string, string>;
  head: { cid: string; seq: number } | null;
  keySignature: string;
  verifier: ChainVerifier | null;
};

/** Result of {@link loadVerifiedExport}. `unchanged` reuses the previous snapshot. */
export type LoadExportResult =
  | { ok: false }
  | { ok: true; unchanged: true; client: ExportClient; etag: string | null }
  | { ok: true; unchanged: false; client: ExportClient; etag: string | null };

type ExportJson = {
  records: unknown[];
  doorPublicKeys: Record<string, string>;
  blobs: Record<string, string>;
};

type FetchOutcome =
  | { kind: "network" }
  | { kind: "not-modified"; etag: string | null }
  | { kind: "unknown" }
  | { kind: "http-error" }
  | { kind: "bad-body" }
  | { kind: "body"; etag: string | null; exported: ExportJson };

type FeedOk = {
  ok: true;
  fed: number;
  records: OspRecord[];
  head: { cid: string; seq: number } | null;
};

type FeedResult = FeedOk | { ok: false; fed: number };

/**
 * Decode a door-key map for the verifier.
 * A non-`platform:id` door id throws, which the caller turns into a failed load.
 */
export function sealDoorKeys(encoded: ReadonlyMap<string, string>): PreparedKeys | null {
  try {
    return { decoded: decodeDoorKeys(encoded), signature: signatureOf(encoded) };
  } catch {
    return null;
  }
}

/**
 * Admit `rawRecords` into `verifier`.
 * When `clock` is set, yield at least every {@link CHAIN_VERIFY_CHUNK_MS} of that clock
 * before the next record.
 */
export async function feedVerifier(
  verifier: ChainVerifier,
  rawRecords: readonly unknown[],
  clock: VerifyClock | null
): Promise<FeedResult> {
  const now = clock === null ? null : clock.now;
  const yieldControl = clock === null ? null : clock.yield;
  const records: OspRecord[] = [];
  let fed = 0;
  let chunkStart = now === null ? 0 : now();
  for (const raw of rawRecords) {
    if (now !== null && yieldControl !== null) {
      const stamp = now();
      if (stamp - chunkStart >= CHAIN_VERIFY_CHUNK_MS) {
        await yieldControl();
        chunkStart = stamp;
      }
    }
    let step: Awaited<ReturnType<ChainVerifier["evaluate"]>>;
    try {
      step = await verifier.evaluate(raw);
    } catch {
      return { ok: false, fed };
    }
    if (step.failures.length > 0 || step.record === null || step.cid === null) {
      return { ok: false, fed };
    }
    step.commit();
    records.push(step.record);
    fed += 1;
  }
  return { ok: true, fed, records, head: headCopy(verifier) };
}

/**
 * Fetch and verify one export. A verified head requests `?after=<head cid>`
 * and feeds only that tail. An unknown cursor, a tail that does not extend the
 * head, or a tail whose bytes are not a chain suffix drops the client and
 * performs one full GET.
 */
export async function loadVerifiedExport(input: {
  atlasUrl: string;
  previous: ExportClient | null;
  hooks: VerifyHooks;
  soulPublicKey: string | null;
  prepareKeys: (encoded: Record<string, string>) => PreparedKeys | null;
}): Promise<LoadExportResult> {
  const fetchFn = input.hooks.fetch;
  const now = input.hooks.now;
  const yieldControl = input.hooks.yield;
  const createVerifier = input.hooks.createVerifier;
  const previous = input.previous;
  if (previous !== null && previous.head !== null) {
    const tailed = await loadTail({
      atlasUrl: input.atlasUrl,
      previous,
      fetchFn,
      now,
      yieldControl,
      prepareKeys: input.prepareKeys,
      soulPublicKey: input.soulPublicKey
    });
    if (tailed.action === "done") {
      return tailed.result;
    }
  }
  return loadFull({
    atlasUrl: input.atlasUrl,
    previous,
    fetchFn,
    now,
    yieldControl,
    createVerifier,
    prepareKeys: input.prepareKeys,
    soulPublicKey: input.soulPublicKey
  });
}

type TailInput = {
  atlasUrl: string;
  previous: ExportClient;
  fetchFn: PageFetch;
  now: () => number;
  yieldControl: () => Promise<void>;
  prepareKeys: (encoded: Record<string, string>) => PreparedKeys | null;
  soulPublicKey: string | null;
};

async function loadTail(
  input: TailInput
): Promise<{ action: "done"; result: LoadExportResult } | { action: "reset" }> {
  const head = input.previous.head;
  if (head === null) {
    return { action: "reset" };
  }
  const outcome = await fetchExport(
    exportUrl(input.atlasUrl, head.cid),
    conditionalHeaders(input.previous, head.cid),
    input.fetchFn
  );
  if (outcome.kind === "network" || outcome.kind === "http-error") {
    stopClient(input.previous);
    return { action: "done", result: { ok: false } };
  }
  if (outcome.kind === "unknown" || outcome.kind === "bad-body") {
    return { action: "reset" };
  }
  if (outcome.kind === "not-modified") {
    if (input.previous.etagAfter !== head.cid) {
      return { action: "reset" };
    }
    input.previous.etag = outcome.etag ?? input.previous.etag;
    return {
      action: "done",
      result: { ok: true, unchanged: true, client: input.previous, etag: input.previous.etag }
    };
  }
  // A tail is trusted only when it extends the head this page already verified.
  if (!tailExtends(head, outcome.exported.records)) {
    return { action: "reset" };
  }
  const prepared = input.prepareKeys(outcome.exported.doorPublicKeys);
  if (prepared === null) {
    stopClient(input.previous);
    return { action: "done", result: { ok: false } };
  }
  if (prepared.signature !== input.previous.keySignature) {
    return { action: "reset" };
  }
  if (outcome.exported.records.length === 0) {
    input.previous.etag = outcome.etag;
    input.previous.etagAfter = head.cid;
    return {
      action: "done",
      result: { ok: true, unchanged: true, client: input.previous, etag: outcome.etag }
    };
  }
  const fed = await feedHeld(input.previous, outcome.exported.records, {
    now: input.now,
    yield: input.yieldControl
  });
  if (!fed.ok || fed.head === null) {
    stopClient(input.previous);
    return { action: "done", result: { ok: false } };
  }
  const records = [...input.previous.records, ...fed.records];
  if (!soulOk(records, input.soulPublicKey)) {
    stopClient(input.previous);
    return { action: "done", result: { ok: false } };
  }
  input.previous.records = records;
  input.previous.blobs = dropTombstones(fed.records, {
    ...input.previous.blobs,
    ...outcome.exported.blobs
  });
  input.previous.head = fed.head;
  input.previous.etag = outcome.etag;
  input.previous.etagAfter = head.cid;
  input.previous.keySignature = prepared.signature;
  return {
    action: "done",
    result: { ok: true, unchanged: false, client: input.previous, etag: outcome.etag }
  };
}

type FullInput = Omit<TailInput, "previous"> & {
  previous: ExportClient | null;
  createVerifier: (options: VerifyChainOptions) => ChainVerifier;
};

async function loadFull(input: FullInput): Promise<LoadExportResult> {
  stopClient(input.previous);
  const outcome = await fetchExport(exportUrl(input.atlasUrl, null), {}, input.fetchFn);
  if (outcome.kind !== "body") {
    return { ok: false };
  }
  const prepared = input.prepareKeys(outcome.exported.doorPublicKeys);
  if (prepared === null) {
    return { ok: false };
  }
  const verifier = input.createVerifier({ doorPublicKeys: prepared.decoded });
  const fed = await feedVerifier(verifier, outcome.exported.records, {
    now: input.now,
    yield: input.yieldControl
  });
  if (!fed.ok || fed.fed !== outcome.exported.records.length) {
    return { ok: false };
  }
  if (outcome.exported.records.length > 0 && fed.head === null) {
    return { ok: false };
  }
  if (!soulOk(fed.records, input.soulPublicKey)) {
    return { ok: false };
  }
  return {
    ok: true,
    unchanged: false,
    etag: outcome.etag,
    client: {
      etag: outcome.etag,
      etagAfter: null,
      records: fed.records,
      blobs: dropTombstones(fed.records, outcome.exported.blobs),
      head: fed.head,
      keySignature: prepared.signature,
      verifier
    }
  };
}

async function feedHeld(
  client: ExportClient,
  rawRecords: readonly unknown[],
  clock: VerifyClock
): Promise<FeedResult> {
  if (client.verifier === null) {
    return { ok: false, fed: 0 };
  }
  return feedVerifier(client.verifier, rawRecords, clock);
}

function stopClient(client: ExportClient | null): void {
  if (client === null) {
    return;
  }
  client.verifier = null;
}

async function fetchExport(
  url: string,
  headers: Record<string, string>,
  fetchFn: PageFetch
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetchFn(url, { cache: "no-store", headers });
  } catch {
    return { kind: "network" };
  }
  const etag = response.headers.get("etag");
  if (response.status === 304) {
    return { kind: "not-modified", etag };
  }
  if (response.status === 404) {
    const code = await readErrorCode(response);
    return code === EXPORT_AFTER_UNKNOWN ? { kind: "unknown" } : { kind: "http-error" };
  }
  if (!response.ok) {
    return { kind: "http-error" };
  }
  try {
    const payload: unknown = await response.json();
    const exported = readExport(payload);
    if (exported === null) {
      return { kind: "bad-body" };
    }
    return { kind: "body", etag, exported };
  } catch {
    return { kind: "bad-body" };
  }
}

function exportUrl(atlasUrl: string, after: string | null): string {
  const base = `${atlasUrl.replace(/\/+$/u, "")}/chain/export`;
  if (after === null) {
    return base;
  }
  return `${base}?after=${after}`;
}

function conditionalHeaders(client: ExportClient, after: string): Record<string, string> {
  if (client.etag === null || client.etag.length === 0 || client.etagAfter !== after) {
    return {};
  }
  return { "If-None-Match": client.etag };
}

/**
 * True when `records` is empty or its first record continues `head`.
 * Anything else is not a suffix and must not be fed to the verifier.
 */
function tailExtends(head: { cid: string; seq: number }, records: readonly unknown[]): boolean {
  const first = records[0];
  if (first === undefined) {
    return true;
  }
  const link = readLink(first);
  if (link === null) {
    return false;
  }
  return link.prev === head.cid && link.seq === head.seq + 1;
}

function readLink(value: unknown): { prev: string; seq: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("prev" in value) || !("seq" in value)) {
    return null;
  }
  const prev: unknown = value.prev;
  const seq: unknown = value.seq;
  if (typeof prev !== "string" || typeof seq !== "number" || !Number.isInteger(seq)) {
    return null;
  }
  return { prev, seq };
}

function dropTombstones(
  records: readonly OspRecord[],
  blobs: Readonly<Record<string, string>>
): Record<string, string> {
  const next: Record<string, string> = { ...blobs };
  for (const record of records) {
    if (record.type === "tombstone") {
      delete next[record.body.blob_cid];
    }
  }
  return next;
}

function soulOk(records: readonly OspRecord[], soulPublicKey: string | null): boolean {
  if (soulPublicKey === null) {
    return true;
  }
  const genesis = records[0];
  return (
    genesis !== undefined &&
    genesis.type === "genesis" &&
    genesis.body.soul_pubkey === soulPublicKey
  );
}

function headCopy(verifier: ChainVerifier): { cid: string; seq: number } | null {
  const head = verifier.head;
  if (head === null) {
    return null;
  }
  return { cid: head.cid, seq: head.seq };
}

function readExport(value: unknown): ExportJson | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("records" in value) || !("doorPublicKeys" in value)) {
    return null;
  }
  const records: unknown = value.records;
  const doorPublicKeys: unknown = value.doorPublicKeys;
  if (!Array.isArray(records) || !isStringMap(doorPublicKeys)) {
    return null;
  }
  const blobs: unknown = "blobs" in value ? value.blobs : {};
  if (!isStringMap(blobs)) {
    return null;
  }
  return { records, doorPublicKeys, blobs };
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function signatureOf(encoded: ReadonlyMap<string, string>): string {
  const lines: string[] = [];
  for (const [doorId, publicKey] of encoded) {
    lines.push(`${doorId}\n${publicKey}`);
  }
  lines.sort();
  return lines.join("\n");
}

function decodeDoorKeys(encoded: ReadonlyMap<string, string>): Record<string, Uint8Array> {
  const decoded: Record<string, Uint8Array> = {};
  for (const [doorId, publicKey] of encoded) {
    if (!DOOR_ID_RE.test(doorId)) {
      throw new Error("door public key id is not a door id");
    }
    Object.defineProperty(decoded, doorId, {
      value: decodePublicKey(publicKey),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return decoded;
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("error" in payload)) {
      return null;
    }
    const error: unknown = payload.error;
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return null;
    }
    const code: unknown = error.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/**
 * Fill any hook the caller omitted with a wrapper that keeps the page as `this`.
 * `fetchImpl` is the page fetch the caller already wrapped.
 */
export function verifyHooks(
  fetchImpl: PageFetch,
  extras: Partial<VerifyHooks> | undefined
): VerifyHooks {
  return {
    fetch: extras?.fetch ?? fetchImpl,
    now: extras?.now ?? windowNow,
    yield: extras?.yield ?? windowYield,
    createVerifier: extras?.createVerifier ?? ((options) => new ChainVerifier(options))
  };
}

function windowNow(): number {
  return globalThis.Date.now();
}

function windowYield(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}
