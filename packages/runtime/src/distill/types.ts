export type CandidateShard = {
  shard_id: string;
  text: string;
  tags?: string[];
};

export type TranscriptLine = {
  role: "user" | "assistant";
  text: string;
  author_id?: string;
};

export interface TranscriptSource {
  read(): Promise<readonly TranscriptLine[]>;
  destroy(): Promise<void>;
}

export type PiiCategory = "email" | "phone" | "handle";

export type DistillOptions = {
  /** Exact-match allowlist for matched PII spans (e.g. `"@allowed_bot"`). */
  piiAllowlist?: readonly string[];
  /** Category-only rejection sink — never pass payload text. */
  onPiiReject?: (category: PiiCategory) => void;
};
