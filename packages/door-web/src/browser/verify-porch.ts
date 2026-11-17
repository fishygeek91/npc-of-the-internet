import {
  canonicalize,
  decodePublicKey,
  decodeSignature,
  RecordSchema,
  verify,
  verifyRecords,
  type OspRecord
} from "@npc/osp-core/browser";

import { roomIdFor, type OutboundProof } from "./proof.js";

/** Visible label for a Wanderer line the browser did not accept. */
export const VERIFICATION_FAILED_LABEL = "verification failed";

/** How the page should treat one line. `plain` is visitor or system text. */
export type LineVerdict = "checking" | "verified" | "failed" | "plain";

/** Pins the porch serves from its own origin. Public keys only. */
export type PorchPins = {
  soulPublicKey: string;
  doorId: string;
  doorPublicKey: string;
  atlasUrl: string | null;
};

/** Chain the page is allowed to trust for session keys. */
export type ChainHold =
  | { phase: "checking" }
  | { phase: "failed" }
  | { phase: "verified"; records: readonly OspRecord[]; sessions: ReadonlyMap<string, string> };

/** Last export fetch, so a `304` can reuse a verified chain. */
export type ChainCache = {
  etag: string | null;
  hold: ChainHold;
};

type ExportBody = {
  records: unknown[];
  doorPublicKeys: Record<string, string>;
};

/**
 * Download `GET /chain/export` and verify it under the porch pins.
 * A failed fetch, an invalid chain, or a pin mismatch is `phase: "failed"`.
 * `304` keeps the previous verified snapshot.
 */
export async function fetchChain(
  pins: PorchPins,
  previous: ChainCache | null,
  fetchImpl: typeof fetch = fetch
): Promise<ChainCache> {
  if (pins.atlasUrl === null) {
    return { etag: null, hold: { phase: "failed" } };
  }
  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (previous?.etag !== null && previous?.etag !== undefined) {
      headers["If-None-Match"] = previous.etag;
    }
    response = await fetchImpl(exportUrl(pins.atlasUrl), {
      cache: "no-store",
      headers
    });
  } catch {
    return { etag: previous?.etag ?? null, hold: { phase: "failed" } };
  }

  const etag = response.headers.get("etag");
  if (response.status === 304) {
    if (previous !== null && previous.hold.phase === "verified") {
      return { etag: etag ?? previous.etag, hold: previous.hold };
    }
    return { etag, hold: { phase: "failed" } };
  }
  if (!response.ok) {
    return { etag: null, hold: { phase: "failed" } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { etag: null, hold: { phase: "failed" } };
  }
  const exported = readExport(payload);
  if (exported === null) {
    return { etag: null, hold: { phase: "failed" } };
  }

  const doorKeys = { ...exported.doorPublicKeys };
  const advertised = doorKeys[pins.doorId];
  if (advertised !== undefined && advertised !== pins.doorPublicKey) {
    return { etag: null, hold: { phase: "failed" } };
  }
  doorKeys[pins.doorId] = pins.doorPublicKey;

  let decoded: Record<string, Uint8Array>;
  try {
    decoded = decodeDoorKeys(doorKeys);
  } catch {
    return { etag: null, hold: { phase: "failed" } };
  }

  let result: Awaited<ReturnType<typeof verifyRecords>>;
  try {
    result = await verifyRecords(exported.records, { doorPublicKeys: decoded });
  } catch {
    return { etag: null, hold: { phase: "failed" } };
  }
  if (!result.valid) {
    return { etag: null, hold: { phase: "failed" } };
  }

  const records: OspRecord[] = [];
  for (const record of exported.records) {
    const parsed = RecordSchema.safeParse(record);
    if (!parsed.success) {
      return { etag: null, hold: { phase: "failed" } };
    }
    records.push(parsed.data);
  }
  const genesis = records[0];
  if (genesis === undefined || genesis.type !== "genesis") {
    return { etag: null, hold: { phase: "failed" } };
  }
  if (genesis.body.soul_pubkey !== pins.soulPublicKey) {
    return { etag: null, hold: { phase: "failed" } };
  }

  return {
    etag,
    hold: { phase: "verified", records, sessions: sessionsFrom(records) }
  };
}

/**
 * Verdict for a room line. Wanderer text is verified only when it matches
 * `signed.body.text` and the session key on the verified arrival signs `signed`.
 */
export function verifyText(
  hold: ChainHold,
  message: { from: string; text: string; proof?: OutboundProof }
): LineVerdict {
  if (message.from !== "wanderer") {
    return "plain";
  }
  if (hold.phase === "checking") {
    return "checking";
  }
  if (hold.phase !== "verified") {
    return "failed";
  }
  const proof = message.proof;
  if (proof === undefined || proof.signed.type !== "outbound") {
    return "failed";
  }
  if (proof.signed.body.text !== message.text) {
    return "failed";
  }
  return signatureOk(hold, proof) ? "verified" : "failed";
}

/**
 * Verdict for a reaction chip. The signed reaction must be that emoji and
 * must target this room line.
 */
export function verifyReaction(
  hold: ChainHold,
  targetId: string,
  reaction: { emoji: string; proof: OutboundProof }
): Exclude<LineVerdict, "plain"> {
  if (hold.phase === "checking") {
    return "checking";
  }
  if (hold.phase !== "verified") {
    return "failed";
  }
  const signedReaction = reaction.proof.signed.body.reaction;
  if (signedReaction === undefined) {
    return "failed";
  }
  if (signedReaction.emoji !== reaction.emoji) {
    return "failed";
  }
  if (roomIdFor(reaction.proof.signed.epoch, signedReaction.target_msg_id) !== targetId) {
    return "failed";
  }
  return signatureOk(hold, reaction.proof) ? "verified" : "failed";
}

/** Join the Atlas origin to the export path. */
function exportUrl(atlasUrl: string): string {
  return `${atlasUrl.replace(/\/+$/u, "")}/chain/export`;
}

function readExport(value: unknown): ExportBody | null {
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
  return { records, doorPublicKeys };
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function decodeDoorKeys(encoded: Record<string, string>): Record<string, Uint8Array> {
  const decoded: Record<string, Uint8Array> = {};
  for (const [doorId, publicKey] of Object.entries(encoded)) {
    decoded[doorId] = decodePublicKey(publicKey);
  }
  return decoded;
}

function sessionsFrom(records: readonly OspRecord[]): Map<string, string> {
  const sessions = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "attestation" || record.body.kind !== "arrival") {
      continue;
    }
    sessions.set(`${record.body.door_id}/${String(record.body.epoch)}`, record.body.session_pubkey);
  }
  return sessions;
}

function signatureOk(
  hold: Extract<ChainHold, { phase: "verified" }>,
  proof: OutboundProof
): boolean {
  const session = hold.sessions.get(`${proof.signed.door_id}/${String(proof.signed.epoch)}`);
  if (session === undefined) {
    return false;
  }
  try {
    return verify(canonicalize(proof.signed), decodeSignature(proof.sig), decodePublicKey(session));
  } catch {
    return false;
  }
}
