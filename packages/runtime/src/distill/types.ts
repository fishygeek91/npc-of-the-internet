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
  piiAllowlist?: readonly string[];
  /** Category-only rejection sink — never pass payload text. */
  onPiiReject?: (category: PiiCategory) => void;
};
