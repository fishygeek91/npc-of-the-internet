import type { HeadResponse, JournalEntry, RecordsPageResponse, StateResponse } from "@npc/atlas";
import {
  ChainView,
  deriveHead,
  deriveJournals,
  deriveRecordsPage,
  deriveState,
  extractRecordTimestamp,
  formatRecordKind,
  type ChainSnapshot
} from "@npc/atlas";
import { computeCid, verifyRecords, type OspRecord, type VerifyChainResult } from "@npc/osp-core";
import { loadAtlasSiteConfig } from "./config.js";
import { prettyPrintBody, toDisplayBody } from "./display-body.js";
import { deriveJourney, type JourneyEntry } from "./journey.js";
import { renderJournalHtml } from "./markdown.js";
import { recordVerified } from "./verification.js";

const RECORDS_PER_PAGE = 5;

const RECORD_TYPES = [
  "genesis",
  "memory",
  "drift",
  "decision",
  "transaction",
  "attestation",
  "sleep"
] as const;

/** Explorer detail for one soulchain record. */
export type RecordDetail = {
  seq: number;
  cid: string;
  kind: string;
  type: OspRecord["type"];
  issued_at: string | null;
  verified: boolean;
  prev: string | null;
  residency: string | null;
  cosigners: readonly string[];
  displayBody: unknown;
  displayBodyJson: string;
};

/** Journal entry with pre-rendered HTML for static pages. */
export type JournalWithHtml = JournalEntry & {
  html: string;
};

/** Full build-time dataset for the Atlas static site. */
export type AtlasSiteData = {
  basePath: string;
  chainDir: string;
  chainVerified: boolean;
  state: StateResponse;
  head: HeadResponse | null;
  journey: JourneyEntry[];
  journals: JournalWithHtml[];
  recordTypes: string[];
  totalRecords: number;
  recordsPages: RecordsPageResponse[];
  records: RecordDetail[];
};

/**
 * Collect distinct top-level record types present in the chain.
 */
function collectRecordTypes(records: readonly OspRecord[]): string[] {
  const present = new Set<string>();
  for (const record of records) {
    present.add(record.type);
  }

  return RECORD_TYPES.filter((type) => present.has(type));
}

/**
 * Build explorer detail objects for every record in the chain.
 */
async function buildRecordDetails(
  records: readonly OspRecord[],
  verifyResult: VerifyChainResult
): Promise<RecordDetail[]> {
  const details: RecordDetail[] = [];

  for (const record of records) {
    details.push({
      seq: record.seq,
      cid: await computeCid(record),
      kind: formatRecordKind(record),
      type: record.type,
      issued_at: extractRecordTimestamp(record),
      verified: recordVerified(record.seq, verifyResult),
      prev: record.prev,
      residency: record.residency,
      cosigners: record.cosigners,
      displayBody: toDisplayBody(record),
      displayBodyJson: prettyPrintBody(record)
    });
  }

  return details;
}

/**
 * Paginate all records with a fixed page size, collecting every page.
 */
async function collectAllRecordPages(
  records: readonly OspRecord[],
  chainVerified: boolean
): Promise<RecordsPageResponse[]> {
  const firstPage = await deriveRecordsPage(records, chainVerified, {
    page: 1,
    per_page: RECORDS_PER_PAGE
  });

  const pages: RecordsPageResponse[] = [firstPage];
  const totalPages = Math.ceil(firstPage.total / RECORDS_PER_PAGE);

  for (let page = 2; page <= totalPages; page += 1) {
    pages.push(
      await deriveRecordsPage(records, chainVerified, {
        page,
        per_page: RECORDS_PER_PAGE
      })
    );
  }

  return pages;
}

/**
 * Merge ChainView load-time verification with an explicit `verifyRecords` pass.
 * Read-only opens can flag torn tails even when parsed records verify cleanly.
 */
function buildEffectiveVerifyResult(
  snapshot: ChainSnapshot,
  verifyResult: VerifyChainResult
): VerifyChainResult {
  if (snapshot.verified && verifyResult.valid) {
    return { valid: true, head: null };
  }

  if (!verifyResult.valid) {
    return verifyResult;
  }

  const lastRecord = snapshot.records[snapshot.records.length - 1];
  const failureSeq = lastRecord?.seq ?? 0;
  return {
    valid: false,
    failures: [
      {
        seq: failureSeq,
        rule: "schema_violation",
        message: "chain integrity failure detected at load"
      }
    ]
  };
}

/**
 * Load and derive all build-time data for the Atlas static site.
 *
 * @param env - Optional environment map for configuration (defaults to `process.env`).
 * @throws {Error} when configuration is invalid or the soulchain is unreadable.
 */
export async function loadSiteData(env?: NodeJS.ProcessEnv): Promise<AtlasSiteData> {
  const config = await loadAtlasSiteConfig(env);

  const view = new ChainView({
    chainDir: config.chainDir,
    doorPublicKeys: config.doorPublicKeys
  });

  let snapshot;
  try {
    snapshot = await view.snapshot();
  } finally {
    await view.close();
  }

  if (snapshot.unreadable === true) {
    const detail =
      snapshot.unreadableMessage === undefined ? "" : `: ${snapshot.unreadableMessage}`;
    throw new Error(`Soulchain at ATLAS_SITE_CHAIN_DIR is unreadable${detail}`);
  }

  const verifyResult = await verifyRecords(snapshot.records, {
    doorPublicKeys: config.doorPublicKeys
  });
  const effectiveVerifyResult = buildEffectiveVerifyResult(snapshot, verifyResult);
  const chainVerified = snapshot.verified && verifyResult.valid;

  const state = deriveState(snapshot.records, chainVerified);
  const head = await deriveHead(snapshot.records, chainVerified);
  const journey = await deriveJourney(snapshot.records);
  const journalsResponse = await deriveJournals(snapshot.records, chainVerified);

  const journals: JournalWithHtml[] = journalsResponse.journals.map((entry) => ({
    ...entry,
    html: renderJournalHtml(entry.journal)
  }));

  const records = await buildRecordDetails(snapshot.records, effectiveVerifyResult);
  const recordsPages = await collectAllRecordPages(snapshot.records, chainVerified);
  const recordTypes = collectRecordTypes(snapshot.records);

  return {
    basePath: config.basePath,
    chainDir: config.chainDir,
    chainVerified,
    state,
    head,
    journey,
    journals,
    recordTypes,
    totalRecords: snapshot.records.length,
    recordsPages,
    records
  };
}
