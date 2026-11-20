import {
  arrivalForEpoch,
  arrivalsForDoor,
  canonicalize,
  decodePublicKey,
  decodeSignature,
  scanPresence,
  verify,
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
import { readProof, roomIdFor, type ProofBytes } from "./proof.js";

/** Visible label for a Wanderer line the browser did not accept. */
export const VERIFICATION_FAILED_LABEL = "verification failed";

/**
 * How the page should treat one line. `plain` is visitor or system text.
 * `verified` is live speech of the open epoch. `earlier` is a verified past
 * epoch, shown as an earlier visit and never as live speech.
 */
export type LineVerdict = "checking" | "verified" | "earlier" | "failed" | "plain";

/** Pins the porch serves from its own origin. Public keys only. */
export type PorchPins = {
  soulPublicKey: string;
  doorId: string;
  doorPublicKey: string;
  atlasUrl: string | null;
};

/**
 * The one arrival whose session key may verify lines on this porch.
 * `doorId` is the porch's configured door id.
 */
export type OpenResidency = {
  doorId: string;
  epoch: number;
  sessionPubkey: string;
};

/**
 * Chain the page is allowed to trust for session keys at this porch.
 * `open` is null when the chain is valid but the Wanderer is sleeping,
 * traveling, or present at another Door. Past arrivals in `arrivals` still
 * verify lines from those epochs. `epochCeiling` is the highest epoch on any
 * verified attestation, or 0 when the chain has none.
 */
export type ChainHold =
  | { phase: "checking" }
  | { phase: "failed" }
  | {
      phase: "verified";
      /** This porch's door id. Lines for any other door fail. */
      doorId: string;
      open: OpenResidency | null;
      /** Every arrival at this porch, authenticated by the verified chain. */
      arrivals: readonly OpenResidency[];
      epochCeiling: number;
    };

/**
 * Last export fetch. `etag` is set only while `hold` is verified, so a
 * later poll can send `If-None-Match`. A failure stores neither.
 */
export type ChainCache = {
  etag: string | null;
  hold: ChainHold;
  /** Incremental verifier for this page. Null after a failed fetch. */
  client: ExportClient | null;
};

/**
 * Download `GET /chain/export` and verify it under the porch pins.
 * A verified head refetches `?after=<cid>` and feeds only that tail.
 * Failure stores no ETag and no verified snapshot. `304` reuses a snapshot
 * only when that snapshot was already verified (`spec/door/web.md`).
 */
export async function fetchChain(
  pins: PorchPins,
  previous: ChainCache | null,
  fetchImpl: PageFetch = windowFetch,
  hooks?: Partial<VerifyHooks>
): Promise<ChainCache> {
  if (pins.atlasUrl === null) {
    return failedCache();
  }
  const loaded = await loadVerifiedExport({
    atlasUrl: pins.atlasUrl,
    previous: previous?.client ?? null,
    hooks: verifyHooks(fetchImpl, hooks),
    soulPublicKey: pins.soulPublicKey,
    prepareKeys: (encoded) => porchKeys(pins, encoded)
  });
  if (!loaded.ok) {
    return failedCache();
  }
  if (loaded.unchanged && previous !== null && previous.hold.phase === "verified") {
    return { etag: loaded.etag, hold: previous.hold, client: loaded.client };
  }
  const records = loaded.client.records;
  return {
    etag: loaded.etag,
    hold: {
      phase: "verified",
      doorId: pins.doorId,
      open: openPorchArrival(records, pins.doorId),
      arrivals: porchArrivals(records, pins.doorId),
      epochCeiling: chainEpochCeiling(records)
    },
    client: loaded.client
  };
}

/** Page `fetch`. A bare `fetch(...)` drops `this` and throws in browsers. */
function windowFetch(url: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init);
}

/**
 * Verdict for a room line. Wanderer text must match the original
 * `signed.body.text` and the arrival `session_pubkey` for `signed.epoch` at
 * this porch. The open epoch is `verified` (live). A past epoch is `earlier`.
 * An epoch newer than the snapshot is `checking`. A bad proof is `failed`.
 */
export function verifyText(
  hold: ChainHold,
  message: { from: string; text: string; proof?: unknown }
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
  const proof = readProof(message.proof);
  if (proof === null) {
    return "failed";
  }
  const text = signedText(proof.signed);
  if (text === null || text !== message.text) {
    return "failed";
  }
  return verdictForEpoch(hold, proof);
}

/**
 * True when a well-formed Wanderer line for this porch names an epoch the
 * verified snapshot has not reached yet. The page keeps that line `checking`
 * and refetches. A wrong door, a text mismatch, or a malformed proof is not
 * waiting on a refetch.
 */
export function lineAwaitsEpoch(
  hold: ChainHold,
  message: { from: string; text: string; proof?: unknown }
): boolean {
  if (message.from !== "wanderer" || hold.phase !== "verified") {
    return false;
  }
  const proof = readProof(message.proof);
  if (proof === null) {
    return false;
  }
  const text = signedText(proof.signed);
  if (text === null || text !== message.text) {
    return false;
  }
  const place = signedPlace(proof.signed);
  if (place === null || place.doorId !== hold.doorId) {
    return false;
  }
  return place.epoch > hold.epochCeiling && findArrival(hold.arrivals, place.epoch) === undefined;
}

/**
 * Verdict for a reaction chip. The signed emoji and target must match.
 * A malformed proof is `failed` and does not throw.
 */
export function verifyReaction(
  hold: ChainHold,
  targetId: string,
  reaction: { emoji: string; proof: unknown }
): Exclude<LineVerdict, "plain"> {
  if (hold.phase === "checking") {
    return "checking";
  }
  if (hold.phase !== "verified") {
    return "failed";
  }
  const proof = readProof(reaction.proof);
  if (proof === null) {
    return "failed";
  }
  const signed = signedReaction(proof.signed);
  const place = signedPlace(proof.signed);
  if (signed === null || place === null || signed.emoji !== reaction.emoji) {
    return "failed";
  }
  if (roomIdFor(place.epoch, signed.targetMsgId) !== targetId) {
    return "failed";
  }
  return verdictForEpoch(hold, proof);
}

/**
 * Open arrival for this porch, or null. {@link scanPresence} is the same
 * newest-first scan as Atlas `deriveState` and the shrine badge: sleep, or
 * departure / travel / handover, or another Door, means none. The key is that
 * epoch's first arrival `session_pubkey`, not a heartbeat key.
 */
export function openPorchArrival(
  records: readonly OspRecord[],
  porchDoorId: string
): OpenResidency | null {
  const presence = scanPresence(records);
  if (presence.status !== "present" || presence.doorId !== porchDoorId) {
    return null;
  }
  const arrival = arrivalForEpoch(records, presence.doorId, presence.epoch);
  if (arrival === null) {
    return null;
  }
  return {
    doorId: arrival.doorId,
    epoch: arrival.epoch,
    sessionPubkey: arrival.sessionPubkey
  };
}

/**
 * Cache entry that forces the next poll to GET the export again.
 */
function failedCache(): ChainCache {
  return { etag: null, hold: { phase: "failed" }, client: null };
}

/** Overlay this porch's pinned door key, then decode the map. A mismatch is null. */
function porchKeys(pins: PorchPins, encoded: Record<string, string>): PreparedKeys | null {
  const keys = new Map<string, string>();
  for (const [doorId, publicKey] of Object.entries(encoded)) {
    keys.set(doorId, publicKey);
  }
  const advertised = keys.get(pins.doorId);
  if (advertised !== undefined && advertised !== pins.doorPublicKey) {
    return null;
  }
  keys.set(pins.doorId, pins.doorPublicKey);
  return sealDoorKeys(keys);
}

/** Every arrival at this porch, in chain order. The chain authenticated each key. */
function porchArrivals(records: readonly OspRecord[], porchDoorId: string): OpenResidency[] {
  const arrivals: OpenResidency[] = [];
  for (const arrival of arrivalsForDoor(records, porchDoorId)) {
    arrivals.push({
      doorId: arrival.doorId,
      epoch: arrival.epoch,
      sessionPubkey: arrival.sessionPubkey
    });
  }
  return arrivals;
}

/**
 * Highest epoch named by a verified attestation, or 0.
 * A line with a greater epoch is newer than this snapshot.
 */
function chainEpochCeiling(records: readonly OspRecord[]): number {
  let ceiling = 0;
  for (const record of records) {
    if (record.type !== "attestation") {
      continue;
    }
    for (const epoch of attestationEpochs(record.body)) {
      if (epoch > ceiling) {
        ceiling = epoch;
      }
    }
  }
  return ceiling;
}

/** Epoch numbers an attestation publishes. Travel and handover use their own fields. */
function attestationEpochs(
  body: Extract<OspRecord, { type: "attestation" }>["body"]
): readonly number[] {
  switch (body.kind) {
    case "arrival":
    case "heartbeat":
    case "departure":
      return [body.epoch];
    case "travel":
      return [body.from_epoch];
    case "handover":
      return [body.depart_epoch, body.arrive_epoch];
    default: {
      const unexpected: never = body;
      throw new Error(`unexpected attestation ${String(unexpected)}`);
    }
  }
}

/** Arrival for `epoch` at this porch, or null when the snapshot has none. */
function findArrival(arrivals: readonly OpenResidency[], epoch: number): OpenResidency | undefined {
  for (const arrival of arrivals) {
    if (arrival.epoch === epoch) {
      return arrival;
    }
  }
  return undefined;
}

/**
 * Live, earlier, checking, or failed for one proof against a verified hold.
 * The session key is that epoch's arrival, not whichever stay is open now.
 */
function verdictForEpoch(
  hold: Extract<ChainHold, { phase: "verified" }>,
  proof: ProofBytes
): Exclude<LineVerdict, "plain"> {
  const place = signedPlace(proof.signed);
  if (place === null || place.doorId !== hold.doorId) {
    return "failed";
  }
  const arrival = findArrival(hold.arrivals, place.epoch);
  if (arrival === undefined) {
    return place.epoch > hold.epochCeiling ? "checking" : "failed";
  }
  if (!signatureOk(arrival.sessionPubkey, proof, place)) {
    return "failed";
  }
  if (hold.open !== null && hold.open.epoch === place.epoch && hold.open.doorId === place.doorId) {
    return "verified";
  }
  return "earlier";
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `signed.body.text` from the original object, or null. */
function signedText(signed: Record<string, unknown>): string | null {
  const body = signed["body"];
  if (!isRecord(body)) {
    return null;
  }
  const text = body["text"];
  return typeof text === "string" ? text : null;
}

/** `signed.body.reaction` from the original object, or null. */
function signedReaction(
  signed: Record<string, unknown>
): { emoji: string; targetMsgId: string } | null {
  const body = signed["body"];
  if (!isRecord(body)) {
    return null;
  }
  const reaction = body["reaction"];
  if (!isRecord(reaction)) {
    return null;
  }
  const emoji = reaction["emoji"];
  const targetMsgId = reaction["target_msg_id"];
  if (typeof emoji !== "string" || typeof targetMsgId !== "string") {
    return null;
  }
  return { emoji, targetMsgId };
}

/** Door id and epoch from the original signed frame, or null. */
function signedPlace(signed: Record<string, unknown>): { doorId: string; epoch: number } | null {
  const doorId = signed["door_id"];
  const epoch = signed["epoch"];
  if (typeof doorId !== "string" || typeof epoch !== "number" || !Number.isInteger(epoch)) {
    return null;
  }
  return { doorId, epoch };
}

/** True when `sessionPubkey` signed `proof` for this door and epoch. A bad signature is false. */
function signatureOk(
  sessionPubkey: string,
  proof: ProofBytes,
  expected: { doorId: string; epoch: number }
): boolean {
  if (typeof proof.sig !== "string") {
    return false;
  }
  const place = signedPlace(proof.signed);
  if (place === null || place.doorId !== expected.doorId || place.epoch !== expected.epoch) {
    return false;
  }
  try {
    return verify(
      canonicalize(proof.signed),
      decodeSignature(proof.sig),
      decodePublicKey(sessionPubkey)
    );
  } catch {
    return false;
  }
}
