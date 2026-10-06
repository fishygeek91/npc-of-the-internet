import {
  canonicalize,
  contentAddressSideBlob,
  encodeJournalBlob,
  encodePublicKey,
  encodeSignature,
  encodeShardTextBlob,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";

import { Door, type DoorOptions } from "../../src/door.js";
import type { HostPolicy } from "../../src/policy.js";
import type { ResidencyRecordOptions } from "../../src/residency-record.js";
import {
  DOOR_PROTOCOL_VERSION,
  type AttestRequest,
  type OutboundFrame
} from "../../src/schemas.js";
import {
  attestSigningPayload,
  generateDoorKeypair,
  outboundSigningPayload
} from "../../src/signing.js";
import type { WitnessInput, WitnessMemory, WitnessVerdict } from "../../src/witness.js";

export const DOOR_ID = "web:lantern";
export const EPOCH = 41;
export const NOW = "2026-10-06T12:00:00.000Z";
export const PREV_CID = "bagu" + "a".repeat(57);

/** Fixed clock: every request below is issued at {@link NOW}. */
export const fixedClock = { now: (): string => NOW };

export const basePolicy: HostPolicy = {
  community: {
    name: "Lantern",
    description: "A small web community for door-sdk tests.",
    platform: "web",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest"]
};

/** A Door with real keys plus a recording witness whose verdicts the test controls. */
export type Harness = {
  door: Door;
  doorKeypair: Ed25519Keypair;
  soul: Ed25519Keypair;
  session: Ed25519Keypair;
  /** Every input the witness was asked to judge. */
  witnessCalls: WitnessInput[];
};

export type HarnessOptions = {
  /** Verdict source; `null` builds a Door with no witness (`attest.memory` off). */
  witness?: WitnessMemory | null;
  policy?: Partial<HostPolicy>;
  residencyRecord?: ResidencyRecordOptions;
};

/** Build a Door whose witness records its inputs and (by default) witnesses everything. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const soul = generateKeypair();
  const session = generateKeypair();
  const doorKeypair = generateDoorKeypair();
  const witnessCalls: WitnessInput[] = [];
  const inner: WitnessMemory | null =
    options.witness === undefined
      ? async (): Promise<WitnessVerdict> => ({ witnessed: true })
      : options.witness;
  const policy: HostPolicy = { ...basePolicy, ...options.policy };
  if (inner !== null) {
    policy.witnessMemory = (input) => {
      witnessCalls.push(input);
      return inner(input);
    };
  }
  const doorOptions: DoorOptions = {
    doorId: DOOR_ID,
    doorKeypair,
    soulPublicKey: soul.publicKey,
    clock: fixedClock,
    policy,
    ...(options.residencyRecord === undefined ? {} : { residencyRecord: options.residencyRecord })
  };
  return { door: new Door(doorOptions), doorKeypair, soul, session, witnessCalls };
}

/** Canonical OSP attestation core bound to `(door_id, epoch, kind)`. */
export function attestCore(kind: AttestRequest["kind"], epoch: number): string {
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.2",
      seq: 1,
      prev: PREV_CID,
      type: "attestation",
      body: { kind, door_id: DOOR_ID, epoch },
      residency: `door:${DOOR_ID}/epoch:${String(epoch)}`
    })
  );
}

/** Unsigned core fields of an `osp/0.2` memory record (override anything to break binding). */
export type MemoryCoreFields = {
  spec: string;
  seq: number;
  prev: string;
  type: string;
  body: Record<string, unknown>;
  residency: string;
};

export function residencyFor(epoch: number, doorId = DOOR_ID): string {
  return `door:${doorId}/epoch:${String(epoch)}`;
}

/** `osp/0.2` shard core fields whose `text_cid` / `text_hash` bind `text`. */
export async function shardCoreFields(text: string, epoch = EPOCH): Promise<MemoryCoreFields> {
  const { cid, hash } = await contentAddressSideBlob(encodeShardTextBlob(text));
  return {
    spec: "osp/0.2",
    seq: 7,
    prev: PREV_CID,
    type: "memory",
    body: { kind: "shard", text_cid: cid, text_hash: hash, distilled_at: NOW },
    residency: residencyFor(epoch)
  };
}

/** `osp/0.2` journal core fields whose `journal_cid` / `journal_hash` bind `markdown`. */
export async function journalCoreFields(
  markdown: string,
  epoch = EPOCH
): Promise<MemoryCoreFields> {
  const { cid, hash } = await contentAddressSideBlob(encodeJournalBlob(markdown));
  return {
    spec: "osp/0.2",
    seq: 12,
    prev: PREV_CID,
    type: "memory",
    body: { kind: "journal", journal_cid: cid, journal_hash: hash, written_at: NOW },
    residency: residencyFor(epoch)
  };
}

/** Canonical core string (exactly what the Door signs). */
export function coreString(fields: MemoryCoreFields | Record<string, unknown>): string {
  return new TextDecoder().decode(canonicalize(fields));
}

/** Soul-signed arrival for `epoch` with `session` as the residency key. */
export function arrivalRequest(h: Harness, epoch = EPOCH, session = h.session): AttestRequest {
  const fields: Omit<AttestRequest, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: DOOR_ID,
    epoch,
    kind: "arrival",
    core: attestCore("arrival", epoch),
    session_pubkey: encodePublicKey(session.publicKey),
    issued_at: NOW
  };
  return { ...fields, sig: encodeSignature(sign(attestSigningPayload(fields), h.soul.privateKey)) };
}

/** Arrive at `epoch` (and make `session` the active residency key). */
export async function arrive(h: Harness, epoch = EPOCH, session = h.session): Promise<void> {
  await h.door.attest(arrivalRequest(h, epoch, session));
}

/** Session-signed non-arrival attest. */
export function sessionAttest(
  h: Harness,
  args: {
    kind: Exclude<AttestRequest["kind"], "arrival">;
    core: string;
    text?: string;
    epoch?: number;
    session?: Ed25519Keypair;
    issuedAt?: string;
  }
): AttestRequest {
  const session = args.session ?? h.session;
  const fields: Omit<AttestRequest, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: DOOR_ID,
    epoch: args.epoch ?? EPOCH,
    kind: args.kind,
    core: args.core,
    session_pubkey: encodePublicKey(h.session.publicKey),
    issued_at: args.issuedAt ?? NOW,
    ...(args.text === undefined ? {} : { text: args.text })
  };
  return {
    ...fields,
    sig: encodeSignature(sign(attestSigningPayload(fields), session.privateKey))
  };
}

/** Session-signed `memory` attest for `text` bound by `fields`. */
export function memoryRequest(
  h: Harness,
  fields: MemoryCoreFields,
  text: string,
  epoch = EPOCH
): AttestRequest {
  return sessionAttest(h, { kind: "memory", core: coreString(fields), text, epoch });
}

/** Session-signed departure for `epoch`. */
export function departureRequest(h: Harness, epoch = EPOCH): AttestRequest {
  return sessionAttest(h, { kind: "departure", core: attestCore("departure", epoch), epoch });
}

/** Session-signed outbound frame. */
export function outboundFrame(
  h: Harness,
  msgId: string,
  body: OutboundFrame["body"],
  options: { epoch?: number; session?: Ed25519Keypair; issuedAt?: string } = {}
): OutboundFrame {
  const unsigned: Omit<OutboundFrame, "sig"> = {
    type: "outbound",
    door_id: DOOR_ID,
    epoch: options.epoch ?? EPOCH,
    msg_id: msgId,
    issued_at: options.issuedAt ?? NOW,
    body
  };
  const session = options.session ?? h.session;
  return {
    ...unsigned,
    sig: encodeSignature(sign(outboundSigningPayload(unsigned), session.privateKey))
  };
}

/** A promise plus its resolver (for witnesses that answer when the test says so). */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
