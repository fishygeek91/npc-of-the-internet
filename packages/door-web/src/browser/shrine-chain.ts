import {
  cidMatchesHash,
  decodeBase64Url,
  decodeJournalBlob,
  hashBlobBytes,
  scanPresence,
  type OspRecord
} from "@npc/osp-core/browser";

import {
  loadVerifiedExport,
  sealDoorKeys,
  verifyHooks,
  type ExportClient,
  type PageFetch,
  type PreparedKeys,
  type VerifyHooks
} from "./incremental-chain.js";

/** Shown instead of journal prose when a verified tombstone covers that blob. */
export const JOURNAL_ERASED = "[journal erased]";

const WEB_DOOR_ID_RE = /^web:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  /** Incremental verifier for this embed. Null after a failed fetch. */
  client: ExportClient | null;
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
  fetchImpl: PageFetch = windowFetch,
  hooks?: Partial<VerifyHooks>
): Promise<ShrineCache> {
  if (config.atlasUrl === null) {
    return failedShrine();
  }
  const loaded = await loadVerifiedExport({
    atlasUrl: config.atlasUrl,
    previous: previous?.client ?? null,
    hooks: verifyHooks(fetchImpl, hooks),
    soulPublicKey: config.soulPublicKey,
    prepareKeys: (encoded) => shrineKeys(config, encoded)
  });
  if (!loaded.ok) {
    return failedShrine();
  }
  if (loaded.unchanged && previous !== null && previous.snapshot.phase === "verified") {
    return { etag: loaded.etag, snapshot: previous.snapshot, client: loaded.client };
  }
  const journals = await journalsOf(loaded.client.records, loaded.client.blobs);
  return {
    etag: loaded.etag,
    snapshot: snapshotOf(config, loaded.client.records, journals),
    client: loaded.client
  };
}

function failedShrine(): ShrineCache {
  return { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT, client: null };
}

/** Page `fetch`. A bare `fetch(...)` drops `this` and throws in browsers. */
function windowFetch(url: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init);
}

function shrineKeys(config: ShrineConfig, encoded: Record<string, string>): PreparedKeys | null {
  const source = config.doorPublicKeys ?? encoded;
  const keys = new Map<string, string>();
  for (const [doorId, publicKey] of Object.entries(source)) {
    keys.set(doorId, publicKey);
  }
  return sealDoorKeys(keys);
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
