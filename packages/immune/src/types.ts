/** Rejection reason for a static screen hit (category only — never payload text). */
export type ScreenCategory =
  | "pii.email"
  | "pii.phone"
  | "pii.handle"
  | "injection.instruction"
  | "injection.role_marker"
  | "injection.url_payload";

/** Outcome of {@link screenText}; failures list categories only. */
export type ScreenResult = { ok: true } | { ok: false; categories: ScreenCategory[] };

/** Options for {@link screenText}. */
export type ScreenOptions = {
  /** Exact-span allowlist for PII matches only. Never applies to injection. */
  allowlist?: readonly string[];
};

/** Call site identifier for category-only rejection logging. */
export type ScreenSite = "session.inbound" | "distill.shard";

/** Category-only rejection sink — never pass payload text. */
export type ScreenLogger = (category: ScreenCategory, site: ScreenSite) => void;
