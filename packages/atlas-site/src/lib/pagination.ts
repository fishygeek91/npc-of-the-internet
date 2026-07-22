import type { RecordListItem } from "@npc/atlas";

import { RECORDS_PER_PAGE } from "./constants.js";
import type { RecordDetail } from "./load-site-data.js";

export { RECORDS_PER_PAGE };

/** Paginated records view for static soul pages. */
export type RecordsPageView = {
  records: RecordListItem[];
  page: number;
  per_page: number;
  total: number;
  verified: boolean;
};

/**
 * Derive a paginated records listing from explorer detail objects.
 */
export function deriveRecordsPageView(
  records: readonly RecordDetail[],
  chainVerified: boolean,
  options: { type?: string; page?: number; perPage?: number }
): RecordsPageView {
  const page = Math.max(options.page ?? 1, 1);
  const perPage = options.perPage ?? RECORDS_PER_PAGE;
  const filtered =
    options.type === undefined ? records : records.filter((record) => record.type === options.type);

  const total = filtered.length;
  const start = (page - 1) * perPage;
  const slice = filtered.slice(start, start + perPage);

  return {
    records: slice.map((record): RecordListItem => ({
      cid: record.cid,
      seq: record.seq,
      kind: record.kind,
      issued_at: record.issued_at,
      summary: record.kind
    })),
    page,
    per_page: perPage,
    total,
    verified: chainVerified
  };
}

/**
 * Total number of pages for a record count and page size.
 */
export function totalPages(total: number, perPage: number): number {
  if (total === 0) {
    return 1;
  }
  return Math.ceil(total / perPage);
}

/**
 * Build the site path for a soul records listing page.
 */
export function soulListPath(page: number, type?: string): string {
  if (type !== undefined) {
    return page === 1 ? `/soul/type/${type}/` : `/soul/type/${type}/page/${page}/`;
  }
  return page === 1 ? "/soul/" : `/soul/page/${page}/`;
}
