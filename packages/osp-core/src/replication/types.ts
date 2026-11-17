import { z } from "zod";

import { CidSchema } from "../crypto/cid.js";

/** Kind of content queued for outbound replication. */
export type ReplicationKind = "record" | "manifest" | "car";

/** Zod schema for {@link ReplicationKind}. */
export const ReplicationKindSchema = z.enum(["record", "manifest", "car"]);

/** One enqueue line in `replication.jsonl`. */
export type ReplicationEnqueueEntry = {
  cid: string;
  kind: ReplicationKind;
  enqueued_at: string;
};

/** Zod schema for a replication enqueue entry. */
export const ReplicationEnqueueEntrySchema = z.object({
  cid: CidSchema,
  kind: ReplicationKindSchema,
  enqueued_at: z.string().min(1)
});

/** One ack line in `replication.jsonl` (per target). */
export type ReplicationAckEntry = {
  acked: string;
  target: string;
  at: string;
};

/** Zod schema for a replication ack entry. */
export const ReplicationAckEntrySchema = z.object({
  acked: CidSchema,
  target: z.string().min(1),
  at: z.string().min(1)
});
