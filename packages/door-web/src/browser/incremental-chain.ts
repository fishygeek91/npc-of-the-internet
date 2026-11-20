import {
  ChainVerifier,
  decodePublicKey,
  RecordSchema,
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
 * Worker the page runs one verify job on.
 * `run` is called on the object so `this` is the worker.
 */
export type VerifyWorker = {
  run(request: WorkerVerifyRequest): Promise<WorkerVerifyReply>;
  terminate(): void;
};

/** One verify job. `reset` starts a fresh {@link ChainVerifier} inside the worker. */
export type WorkerVerifyRequest = {
  id: number;
  reset: boolean;
  records: unknown[];
  doorPublicKeys: Record<string, Uint8Array>;
};

/** Reply from {@link WorkerVerifyRequest}. `fed` is how many records were admitted. */
export type WorkerVerifyReply = {
  id: number;
  ok: boolean;
  fed: number;
  head: { cid: string; seq: number } | null;
};

/**
 * Page operations for one verify. Every function is invoked with no receiver
 * so a browser global is not called as a method on this object.
 */
export type VerifyHooks = {
  fetch: PageFetch;
  now: () => number;
  yield: () => Promise<void>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  createWorker: (src: string) => VerifyWorker;
  /** Worker script text. Null skips the worker and verifies in chunks. */
  bundleSource: string | null;
  createVerifier: (options: VerifyChainOptions) => ChainVerifier;
};

/** Door keys ready for `ChainVerifier`, plus a stable signature for later tails. */
export type PreparedKeys = {
  decoded: Record<string, Uint8Array>;
  signature: string;
};

/**
 * One page's chain. The verifier lives here, or in `worker` when the first
 * full verify ran off the main thread. A refetch feeds only the new records.
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
  worker: VerifyWorker | null;
  workerUrl: string | null;
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

let pageScriptUrl: string | null = null;
let cachedBundleSource: string | null = null;
let nextWorkerId = 1;

/**
 * Remember the classic script URL while it is evaluating.
 * A later full verify fetches that URL and runs it as a blob worker.
 */
export function rememberPageScript(host: unknown): void {
  const url = pageScriptSrc(host);
  if (url !== null) {
    pageScriptUrl = url;
  }
}

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
 * before the next record. The worker passes null and does not yield.
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
  const createObjectURL = input.hooks.createObjectURL;
  const revokeObjectURL = input.hooks.revokeObjectURL;
  const createWorker = input.hooks.createWorker;
  const createVerifier = input.hooks.createVerifier;
  const bundleSource = input.hooks.bundleSource;
  const previous = input.previous;
  if (previous !== null && previous.head !== null) {
    const tailed = await loadTail({
      atlasUrl: input.atlasUrl,
      previous,
      fetchFn,
      now,
      yieldControl,
      prepareKeys: input.prepareKeys,
      soulPublicKey: input.soulPublicKey,
      revokeObjectURL
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
    createObjectURL,
    revokeObjectURL,
    createWorker,
    createVerifier,
    bundleSource,
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
  revokeObjectURL: (url: string) => void;
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
    stopClient(input.previous, input.revokeObjectURL);
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
    stopClient(input.previous, input.revokeObjectURL);
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
  const fed = await feedHeld(input.previous, outcome.exported.records, prepared, {
    now: input.now,
    yield: input.yieldControl
  });
  if (!fed.ok || fed.head === null) {
    stopClient(input.previous, input.revokeObjectURL);
    return { action: "done", result: { ok: false } };
  }
  const records = [...input.previous.records, ...fed.records];
  if (!soulOk(records, input.soulPublicKey)) {
    stopClient(input.previous, input.revokeObjectURL);
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
  createObjectURL: (blob: Blob) => string;
  createWorker: (src: string) => VerifyWorker;
  createVerifier: (options: VerifyChainOptions) => ChainVerifier;
  bundleSource: string | null;
};

async function loadFull(input: FullInput): Promise<LoadExportResult> {
  stopClient(input.previous, input.revokeObjectURL);
  const outcome = await fetchExport(exportUrl(input.atlasUrl, null), {}, input.fetchFn);
  if (outcome.kind !== "body") {
    return { ok: false };
  }
  const prepared = input.prepareKeys(outcome.exported.doorPublicKeys);
  if (prepared === null) {
    return { ok: false };
  }
  const verified = await verifyAll(outcome.exported.records, prepared, input);
  if (verified === null || !soulOk(verified.records, input.soulPublicKey)) {
    if (verified !== null) {
      stopClient(verified, input.revokeObjectURL);
    }
    return { ok: false };
  }
  verified.blobs = dropTombstones(verified.records, outcome.exported.blobs);
  verified.etag = outcome.etag;
  verified.etagAfter = null;
  verified.keySignature = prepared.signature;
  return { ok: true, unchanged: false, client: verified, etag: outcome.etag };
}

/** First full verify: blob worker, then chunked main-thread fallback. */
async function verifyAll(
  rawRecords: readonly unknown[],
  prepared: PreparedKeys,
  input: FullInput
): Promise<ExportClient | null> {
  const source = await bundleText(input.fetchFn, input.bundleSource);
  if (source !== null) {
    const started = startWorker(
      source,
      input.createObjectURL,
      input.revokeObjectURL,
      input.createWorker
    );
    if (started !== null) {
      try {
        const reply = await started.worker.run({
          id: takeWorkerId(),
          reset: true,
          records: asRecordList(rawRecords),
          doorPublicKeys: prepared.decoded
        });
        if (
          reply.ok &&
          reply.fed === rawRecords.length &&
          (rawRecords.length === 0 || reply.head !== null)
        ) {
          const parsed = await parseRecords(rawRecords, {
            now: input.now,
            yield: input.yieldControl
          });
          if (parsed !== null) {
            return emptyClient(parsed, reply.head, null, started.worker, started.url);
          }
        }
      } catch {
        // The worker failed or never started. The chunked path below is the fallback.
      }
      stopWorker(started.worker, started.url, input.revokeObjectURL);
    }
  }
  const verifier = input.createVerifier({ doorPublicKeys: prepared.decoded });
  const fed = await feedVerifier(verifier, rawRecords, {
    now: input.now,
    yield: input.yieldControl
  });
  if (!fed.ok || fed.fed !== rawRecords.length) {
    return null;
  }
  if (rawRecords.length > 0 && fed.head === null) {
    return null;
  }
  return emptyClient(fed.records, fed.head, verifier, null, null);
}

function emptyClient(
  records: OspRecord[],
  head: { cid: string; seq: number } | null,
  verifier: ChainVerifier | null,
  worker: VerifyWorker | null,
  workerUrl: string | null
): ExportClient {
  return {
    etag: null,
    etagAfter: null,
    records,
    blobs: {},
    head,
    keySignature: "",
    verifier,
    worker,
    workerUrl
  };
}

async function feedHeld(
  client: ExportClient,
  rawRecords: readonly unknown[],
  prepared: PreparedKeys,
  clock: VerifyClock
): Promise<FeedResult> {
  if (client.worker !== null) {
    try {
      const reply = await client.worker.run({
        id: takeWorkerId(),
        reset: false,
        records: asRecordList(rawRecords),
        doorPublicKeys: prepared.decoded
      });
      if (!reply.ok || reply.fed !== rawRecords.length || reply.head === null) {
        return { ok: false, fed: reply.fed };
      }
      const parsed = await parseRecords(rawRecords, clock);
      if (parsed === null) {
        return { ok: false, fed: reply.fed };
      }
      return { ok: true, fed: reply.fed, records: parsed, head: reply.head };
    } catch {
      return { ok: false, fed: 0 };
    }
  }
  if (client.verifier === null) {
    return { ok: false, fed: 0 };
  }
  return feedVerifier(client.verifier, rawRecords, clock);
}

function startWorker(
  source: string,
  createObjectURL: (blob: Blob) => string,
  revokeObjectURL: (url: string) => void,
  createWorker: (src: string) => VerifyWorker
): { worker: VerifyWorker; url: string } | null {
  let url: string;
  try {
    url = createObjectURL(new Blob([source], { type: "text/javascript" }));
  } catch {
    return null;
  }
  try {
    return { worker: createWorker(url), url };
  } catch {
    try {
      revokeObjectURL(url);
    } catch {
      // The URL may already be unusable. Chunked verify does not need it.
    }
    return null;
  }
}

function asRecordList(rawRecords: readonly unknown[]): unknown[] {
  if (Array.isArray(rawRecords)) {
    return rawRecords;
  }
  return [...rawRecords];
}

function stopClient(client: ExportClient | null, revokeObjectURL: (url: string) => void): void {
  if (client === null) {
    return;
  }
  const worker = client.worker;
  const url = client.workerUrl;
  client.worker = null;
  client.workerUrl = null;
  client.verifier = null;
  stopWorker(worker, url, revokeObjectURL);
}

function stopWorker(
  worker: VerifyWorker | null,
  url: string | null,
  revokeObjectURL: (url: string) => void
): void {
  if (worker !== null) {
    try {
      worker.terminate();
    } catch {
      // Already stopped.
    }
  }
  if (url !== null) {
    try {
      revokeObjectURL(url);
    } catch {
      // Already revoked.
    }
  }
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

/**
 * Parse worker output on the main thread in the same chunk budget as {@link feedVerifier}.
 * A synchronous parse of the whole chain would block longer than that budget.
 */
async function parseRecords(
  rawRecords: readonly unknown[],
  clock: VerifyClock
): Promise<OspRecord[] | null> {
  const now = clock.now;
  const yieldControl = clock.yield;
  const records: OspRecord[] = [];
  let chunkStart = now();
  for (const raw of rawRecords) {
    const stamp = now();
    if (stamp - chunkStart >= CHAIN_VERIFY_CHUNK_MS) {
      await yieldControl();
      chunkStart = stamp;
    }
    const parsed = RecordSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    records.push(parsed.data);
  }
  return records;
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

function readReply(value: unknown, id: number): WorkerVerifyReply | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (!("id" in value) || !("ok" in value) || !("fed" in value) || !("head" in value)) {
    return null;
  }
  if (value.id !== id || typeof value.ok !== "boolean" || typeof value.fed !== "number") {
    return null;
  }
  const head = readHead(value.head);
  if (value.head !== null && head === null) {
    return null;
  }
  return { id, ok: value.ok, fed: value.fed, head };
}

function readHead(value: unknown): { cid: string; seq: number } | null {
  if (typeof value !== "object" || value === null || !("cid" in value) || !("seq" in value)) {
    return null;
  }
  const cid: unknown = value.cid;
  const seq: unknown = value.seq;
  if (typeof cid !== "string" || typeof seq !== "number" || !Number.isInteger(seq)) {
    return null;
  }
  return { cid, seq };
}

function takeWorkerId(): number {
  const id = nextWorkerId;
  nextWorkerId += 1;
  return id;
}

async function bundleText(fetchFn: PageFetch, explicit: string | null): Promise<string | null> {
  if (explicit !== null && explicit.length > 0) {
    return explicit;
  }
  if (pageScriptUrl === null) {
    return null;
  }
  if (cachedBundleSource !== null) {
    return cachedBundleSource;
  }
  try {
    const response = await fetchFn(pageScriptUrl, { cache: "force-cache" });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    if (text.length === 0) {
      return null;
    }
    cachedBundleSource = text;
    return text;
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
    createObjectURL: extras?.createObjectURL ?? windowCreateObjectURL,
    revokeObjectURL: extras?.revokeObjectURL ?? windowRevokeObjectURL,
    createWorker: extras?.createWorker ?? windowCreateWorker,
    bundleSource: extras?.bundleSource ?? null,
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

function windowCreateObjectURL(blob: Blob): string {
  const api = readBlobUrlApi(globalThis);
  if (api === null) {
    throw new Error("blob urls are unavailable");
  }
  return api.createObjectURL(blob);
}

function windowRevokeObjectURL(url: string): void {
  const api = readBlobUrlApi(globalThis);
  if (api === null) {
    throw new Error("blob urls are unavailable");
  }
  api.revokeObjectURL(url);
}

type BlobUrlApi = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

function readBlobUrlApi(host: object): BlobUrlApi | null {
  if (!("URL" in host)) {
    return null;
  }
  const url: unknown = host.URL;
  if (!isBlobUrlApi(url)) {
    return null;
  }
  return {
    createObjectURL: (blob) => url.createObjectURL(blob),
    revokeObjectURL: (objectUrl) => url.revokeObjectURL(objectUrl)
  };
}

function isBlobUrlApi(value: unknown): value is BlobUrlApi {
  if (typeof value !== "function") {
    return false;
  }
  return (
    "createObjectURL" in value &&
    typeof value.createObjectURL === "function" &&
    "revokeObjectURL" in value &&
    typeof value.revokeObjectURL === "function"
  );
}

type PageWorker = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
};

function windowCreateWorker(src: string): VerifyWorker {
  const ctor = readWorkerCtor(globalThis);
  if (ctor === null) {
    throw new Error("Worker is unavailable");
  }
  const worker = new ctor(src);
  return {
    run(request) {
      return new Promise((resolve, reject) => {
        worker.onmessage = (event) => {
          const reply = readReply(event.data, request.id);
          if (reply === null) {
            reject(new Error("worker reply was not a verify result"));
            return;
          }
          resolve(reply);
        };
        worker.onerror = () => {
          reject(new Error("worker failed"));
        };
        worker.postMessage(request);
      });
    },
    terminate() {
      worker.terminate();
    }
  };
}

function readWorkerCtor(host: object): (new (scriptUrl: string) => PageWorker) | null {
  if (!("Worker" in host)) {
    return null;
  }
  const ctor: unknown = host.Worker;
  if (!isWorkerCtor(ctor)) {
    return null;
  }
  return ctor;
}

function isWorkerCtor(value: unknown): value is new (scriptUrl: string) => PageWorker {
  return typeof value === "function";
}

function pageScriptSrc(host: unknown): string | null {
  if (typeof host !== "object" || host === null || !("document" in host)) {
    return null;
  }
  const documentValue: unknown = host.document;
  if (
    typeof documentValue !== "object" ||
    documentValue === null ||
    !("currentScript" in documentValue)
  ) {
    return null;
  }
  const script: unknown = documentValue.currentScript;
  if (typeof script !== "object" || script === null || !("src" in script)) {
    return null;
  }
  const src: unknown = script.src;
  if (typeof src !== "string" || src.length === 0) {
    return null;
  }
  return src;
}
