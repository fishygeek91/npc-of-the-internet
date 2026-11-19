import {
  cidMatchesHash,
  decodeBase64Url,
  decodeJournalBlob,
  decodePublicKey,
  hashBlobBytes,
  RecordSchema,
  scanPresence,
  verifyRecords,
  type OspRecord
} from "@npc/osp-core/browser";

/** Shown instead of journal prose when a verified tombstone covers that blob. */
export const JOURNAL_ERASED = "[journal erased]";

const WEB_DOOR_ID_RE = /^web:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOOR_ID_RE = /^[a-z0-9-]+:[A-Za-z0-9_-]+$/u;

/** Embed settings. `doorPublicKeys === null` means use the export's map. */
export type ShrineConfig = {
  atlasUrl: string | null;
  porchUrl: string | null;
  mount: string;
  soulPublicKey: string | null;
  doorPublicKeys: Readonly<Record<string, string>> | null;
};

/** What the widget may show. `PRESENT` only after a verified present chain. */
export type ShrineSnapshot = {
  phase: "checking" | "failed" | "verified";
  badge: "PRESENT" | "ELSEWHERE";
  detail: "checking" | "verification failed" | "traveling" | "sleeping" | null;
  doorId: string | null;
  porchUrl: string | null;
  journals: readonly string[];
};

/** Last successful export, so `304` can reuse it. */
export type ShrineCache = {
  etag: string | null;
  snapshot: ShrineSnapshot;
};

export const SHRINE_FAILED_SNAPSHOT: ShrineSnapshot = Object.freeze({
  phase: "failed",
  badge: "ELSEWHERE",
  detail: "verification failed",
  doorId: null,
  porchUrl: null,
  journals: Object.freeze([])
});

/** Verify `GET /chain/export`. A bad chain, pin, or fetch carries no journals. */
export async function loadShrine(
  config: ShrineConfig,
  previous: ShrineCache | null,
  fetchImpl: typeof fetch = fetch
): Promise<ShrineCache> {
  if (config.atlasUrl === null) {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (previous?.etag !== undefined && previous.etag !== null) {
      headers["If-None-Match"] = previous.etag;
    }
    response = await fetchImpl(`${config.atlasUrl}/chain/export`, {
      cache: "no-store",
      headers
    });
  } catch {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  const etag = response.headers.get("etag");
  if (response.status === 304) {
    if (previous !== null && previous.snapshot.phase === "verified") {
      return { etag: etag ?? previous.etag, snapshot: previous.snapshot };
    }
    return { etag, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  if (!response.ok) {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  const exported = readExport(payload);
  if (exported === null) {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  const encodedKeys = config.doorPublicKeys ?? exported.doorPublicKeys;
  let decoded: Record<string, Uint8Array>;
  try {
    decoded = decodeDoorKeys(encodedKeys);
  } catch {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  let verified: Awaited<ReturnType<typeof verifyRecords>>;
  try {
    verified = await verifyRecords(exported.records, { doorPublicKeys: decoded });
  } catch {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  if (!verified.valid) {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  const records: OspRecord[] = [];
  for (const record of exported.records) {
    const parsed = RecordSchema.safeParse(record);
    if (!parsed.success) {
      return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
    }
    records.push(parsed.data);
  }
  if (config.soulPublicKey !== null && !soulPinMatches(records, config.soulPublicKey)) {
    return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT };
  }
  const journals = await journalsOf(records, exported.blobs);
  return { etag, snapshot: snapshotOf(config, records, journals) };
}

function snapshotOf(
  config: ShrineConfig,
  records: readonly OspRecord[],
  journals: readonly string[]
): ShrineSnapshot {
  const presence = presenceOf(records);
  if (presence.kind === "present") {
    const porch =
      config.porchUrl !== null && WEB_DOOR_ID_RE.test(presence.doorId) ? config.porchUrl : null;
    return {
      phase: "verified",
      badge: "PRESENT",
      detail: null,
      doorId: presence.doorId,
      porchUrl: porch,
      journals
    };
  }
  return {
    phase: "verified",
    badge: "ELSEWHERE",
    detail: presence.kind,
    doorId: null,
    porchUrl: null,
    journals
  };
}

/** Badge presence. Same newest-first scan as Atlas `GET /state`. */
function presenceOf(
  records: readonly OspRecord[]
): { kind: "present"; doorId: string } | { kind: "traveling" | "sleeping" } {
  const presence = scanPresence(records);
  if (presence.status === "present") {
    return { kind: "present", doorId: presence.doorId };
  }
  return { kind: presence.status };
}

async function journalsOf(
  records: readonly OspRecord[],
  blobs: Readonly<Record<string, string>>
): Promise<string[]> {
  const erased = new Set<string>();
  for (const record of records) {
    if (record.type === "tombstone") {
      erased.add(record.body.blob_cid);
    }
  }
  const seenHash = new Set<string>();
  const seenInline = new Set<string>();
  const lines: string[] = [];
  for (const record of records) {
    const ref = journalRef(record);
    if (ref === null) {
      continue;
    }
    if (ref.kind === "inline") {
      if (seenInline.has(ref.text)) {
        continue;
      }
      seenInline.add(ref.text);
      lines.push(ref.text);
      continue;
    }
    if (seenHash.has(ref.hash)) {
      continue;
    }
    seenHash.add(ref.hash);
    if (erased.has(ref.cid)) {
      lines.push(JOURNAL_ERASED);
      continue;
    }
    const encoded = blobs[ref.cid];
    if (encoded === undefined) {
      continue;
    }
    const prose = await verifiedProse(encoded, ref.cid, ref.hash);
    if (prose !== null) {
      lines.push(prose);
    }
  }
  return lines;
}

type JournalRef = { kind: "inline"; text: string } | { kind: "blob"; cid: string; hash: string };

function journalRef(record: OspRecord): JournalRef | null {
  if (record.type !== "memory") {
    return null;
  }
  const body = record.body;
  if (body.kind === "journal") {
    return { kind: "blob", cid: body.journal_cid, hash: body.journal_hash };
  }
  if (body.kind !== "shard") {
    return null;
  }
  if ("journal" in body && body.journal !== undefined) {
    return { kind: "inline", text: body.journal };
  }
  if (
    "journal_cid" in body &&
    body.journal_cid !== undefined &&
    "journal_hash" in body &&
    body.journal_hash !== undefined
  ) {
    return { kind: "blob", cid: body.journal_cid, hash: body.journal_hash };
  }
  return null;
}

async function verifiedProse(encoded: string, cid: string, hash: string): Promise<string | null> {
  if (!cidMatchesHash(cid, hash)) {
    return null;
  }
  try {
    const bytes = decodeBase64Url(encoded);
    if ((await hashBlobBytes(bytes)) !== hash) {
      return null;
    }
    return decodeJournalBlob(bytes);
  } catch {
    return null;
  }
}

function soulPinMatches(records: readonly OspRecord[], soulPublicKey: string): boolean {
  const genesis = records[0];
  return (
    genesis !== undefined &&
    genesis.type === "genesis" &&
    genesis.body.soul_pubkey === soulPublicKey
  );
}

function readExport(value: unknown): {
  records: unknown[];
  doorPublicKeys: Record<string, string>;
  blobs: Record<string, string>;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("records" in value) || !("doorPublicKeys" in value)) {
    return null;
  }
  const records = value.records;
  const doorPublicKeys = value.doorPublicKeys;
  if (!Array.isArray(records) || !isStringMap(doorPublicKeys)) {
    return null;
  }
  const blobs = "blobs" in value ? value.blobs : {};
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

function decodeDoorKeys(encoded: Record<string, string>): Record<string, Uint8Array> {
  const decoded: Record<string, Uint8Array> = {};
  for (const [doorId, publicKey] of new Map(Object.entries(encoded))) {
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
