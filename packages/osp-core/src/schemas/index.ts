export {
  OSP_SPEC,
  POP_VERSION,
  GenesisBodySchema,
  ShardBodySchema,
  CandidateBodySchema,
  RejectedBodySchema,
  MemoryBodySchema,
  DriftBodySchema,
  DecisionBodySchema,
  TransactionBodySchema,
  SleepBodySchema,
  ArrivalBodySchema,
  HeartbeatBodySchema,
  DepartureBodySchema,
  TravelBodySchema,
  HandoverBodySchema,
  AttestationBodySchema
} from "./body.js";

export {
  EnvelopeFieldsSchema,
  RecordSchemaBase,
  RecordSchema,
  RESIDENCY_RE,
  parseResidency
} from "./envelope.js";

import type { z } from "zod";

import type {
  ArrivalBodySchema,
  AttestationBodySchema,
  CandidateBodySchema,
  DecisionBodySchema,
  DepartureBodySchema,
  DriftBodySchema,
  GenesisBodySchema,
  HandoverBodySchema,
  HeartbeatBodySchema,
  MemoryBodySchema,
  RejectedBodySchema,
  ShardBodySchema,
  SleepBodySchema,
  TransactionBodySchema,
  TravelBodySchema
} from "./body.js";
import type { RecordSchema } from "./envelope.js";

export type OspRecord = z.infer<typeof RecordSchema>;
export type GenesisBody = z.infer<typeof GenesisBodySchema>;
export type ShardBody = z.infer<typeof ShardBodySchema>;
export type CandidateBody = z.infer<typeof CandidateBodySchema>;
export type RejectedBody = z.infer<typeof RejectedBodySchema>;
export type MemoryBody = z.infer<typeof MemoryBodySchema>;
export type DriftBody = z.infer<typeof DriftBodySchema>;
export type DecisionBody = z.infer<typeof DecisionBodySchema>;
export type TransactionBody = z.infer<typeof TransactionBodySchema>;
export type SleepBody = z.infer<typeof SleepBodySchema>;
export type ArrivalBody = z.infer<typeof ArrivalBodySchema>;
export type HeartbeatBody = z.infer<typeof HeartbeatBodySchema>;
export type DepartureBody = z.infer<typeof DepartureBodySchema>;
export type TravelBody = z.infer<typeof TravelBodySchema>;
export type HandoverBody = z.infer<typeof HandoverBodySchema>;
export type AttestationBody = z.infer<typeof AttestationBodySchema>;
