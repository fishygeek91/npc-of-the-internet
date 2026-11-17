import { canonicalize } from "./canonical.js";
import { computeCid } from "./crypto/cid.js";
import { sign, verify } from "./crypto/ed25519.js";
import { decodeSignature, encodeSignature } from "./encoding/base64url.js";
import { SchemaError, VerificationError } from "./errors.js";
import {
  OSP_SPEC,
  RecordSchema,
  parseResidency,
  type OspRecord,
  type OspSpecVersion
} from "./schemas/index.js";

/** Fields shared by core and soul signing payloads. */
type EnvelopeCoreFields = {
  spec: OspSpecVersion;
  seq: number;
  prev: string | null;
  type: string;
  body: unknown;
  residency: string | null;
};

/** Input fields for record creation (unsigned envelope + cosigner signatures). */
export type CreateRecordFields = {
  seq: number;
  prev: string | null;
  type: OspRecord["type"];
  body: OspRecord["body"];
  residency: string | null;
  /** Door signatures over core bytes; sorted ascending lexicographically before soul signing. */
  cosigners: string[];
};

/** Full input to {@link createRecord}. */
export type CreateRecordInput = CreateRecordFields & {
  soulPrivateKey: Uint8Array;
  /** Defaults to {@link OSP_SPEC} (`osp/0.1` until runtime cutover). */
  spec?: OspSpecVersion;
};

/** Result of {@link createRecord} and {@link createRecordWithSigner}. */
export type CreateRecordResult = {
  record: OspRecord;
  cid: string;
};

/**
 * Signs canonical soul-payload bytes and returns a raw Ed25519 signature.
 *
 * Synchronous on purpose: `Keyring.signWithSoulKey` and `sign` both return
 * `Uint8Array`, not a Promise. {@link createRecordWithSigner} is still async
 * because CID computation is async — the signer itself is not awaited.
 * Pass a closure for a method signer (`(bytes) => keyring.signWithSoulKey(bytes)`);
 * an unbound method would drop `this`.
 */
export type SoulSigner = (bytes: Uint8Array) => Uint8Array;

/** Options for {@link verifyRecord}. */
export type VerifyRecordOptions = {
  soulPublicKey: Uint8Array;
  /**
   * When cosigners are present, each signature must verify against the Door public key
   * for this record's residency (`parseResidency(residency).doorId`).
   */
  doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
  /** When provided, must equal the recomputed CID. */
  expectedCid?: string;
};

/** Result of {@link verifyRecord}. */
export type VerifyRecordResult = {
  record: OspRecord;
  cid: string;
};

/**
 * Build the Door (core) signing payload — envelope fields with `cosigners` and `sig` omitted.
 */
export function corePayload(fields: {
  spec: OspSpecVersion;
  seq: number;
  prev: string | null;
  type: string;
  body: unknown;
  residency: string | null;
}): EnvelopeCoreFields {
  return {
    spec: fields.spec,
    seq: fields.seq,
    prev: fields.prev,
    type: fields.type,
    body: fields.body,
    residency: fields.residency
  };
}

/**
 * Build the soul-key signing payload — envelope fields with only `sig` omitted (includes cosigners).
 */
export function soulPayload(fields: {
  spec: OspSpecVersion;
  seq: number;
  prev: string | null;
  type: string;
  body: unknown;
  residency: string | null;
  cosigners: string[];
}): EnvelopeCoreFields & { cosigners: string[] } {
  return {
    spec: fields.spec,
    seq: fields.seq,
    prev: fields.prev,
    type: fields.type,
    body: fields.body,
    residency: fields.residency,
    cosigners: fields.cosigners
  };
}

/**
 * Sign the core (Door) payload with a Door private key.
 * Returns a base64url-encoded Ed25519 signature over canonical core bytes.
 */
export function signCore(
  fields: Omit<CreateRecordFields, "cosigners"> & { spec?: OspSpecVersion },
  doorPrivateKey: Uint8Array
): string {
  const spec = fields.spec ?? OSP_SPEC;
  const payload = corePayload({
    spec,
    seq: fields.seq,
    prev: fields.prev,
    type: fields.type,
    body: fields.body,
    residency: fields.residency
  });
  const bytes = canonicalize(payload);
  const signature = sign(bytes, doorPrivateKey);
  return encodeSignature(signature);
}

/**
 * Create a signed OSP soulchain record and compute its CID.
 *
 * Normative append order: build unsigned envelope → sort cosigners → soul-sign → validate → CID.
 * `signSoul` receives those canonical soul-payload bytes and returns a raw signature.
 * `spec` defaults to {@link OSP_SPEC} (`osp/0.1`). A schema failure throws {@link SchemaError}.
 */
export async function createRecordWithSigner(
  fields: CreateRecordFields & { spec?: OspSpecVersion },
  signSoul: SoulSigner
): Promise<CreateRecordResult> {
  const spec = fields.spec ?? OSP_SPEC;
  const sortedCosigners = [...fields.cosigners].sort();

  const soulBytes = canonicalize(
    soulPayload({
      spec,
      seq: fields.seq,
      prev: fields.prev,
      type: fields.type,
      body: fields.body,
      residency: fields.residency,
      cosigners: sortedCosigners
    })
  );
  const soulSignature = encodeSignature(signSoul(soulBytes));

  const unsignedRecord = {
    spec,
    seq: fields.seq,
    prev: fields.prev,
    type: fields.type,
    body: fields.body,
    residency: fields.residency,
    cosigners: sortedCosigners,
    sig: soulSignature
  };

  const parsed = RecordSchema.safeParse(unsignedRecord);
  if (!parsed.success) {
    throw new SchemaError(parsed.error.message);
  }

  const record = parsed.data;
  const cid = await computeCid(record);
  return { record, cid };
}

/**
 * Create a signed OSP soulchain record and compute its CID.
 *
 * Thin wrapper over {@link createRecordWithSigner}: the signer is
 * `(bytes) => sign(bytes, soulPrivateKey)`. Default spec, {@link SchemaError}s,
 * and record bytes match that call.
 */
export async function createRecord(input: CreateRecordInput): Promise<CreateRecordResult> {
  const { soulPrivateKey, ...fields } = input;
  return createRecordWithSigner(fields, (bytes) => sign(bytes, soulPrivateKey));
}

/**
 * Verify schema, cosigner signatures (over core bytes), soul signature, and optional expected CID.
 */
export async function verifyRecord(
  input: unknown,
  options: VerifyRecordOptions
): Promise<VerifyRecordResult> {
  const parsed = RecordSchema.safeParse(input);
  if (!parsed.success) {
    throw new SchemaError(parsed.error.message);
  }

  const record = parsed.data;
  const coreBytes = canonicalize(
    corePayload({
      spec: record.spec,
      seq: record.seq,
      prev: record.prev,
      type: record.type,
      body: record.body,
      residency: record.residency
    })
  );

  if (record.cosigners.length > 0) {
    const doorKeys = options.doorPublicKeys;
    if (doorKeys === undefined || Object.keys(doorKeys).length === 0) {
      throw new VerificationError("doorPublicKeys required when cosigners are present");
    }

    if (record.residency === null) {
      throw new VerificationError(
        "cosigners require a non-null residency to resolve Door public key"
      );
    }

    const residencyParts = parseResidency(record.residency);
    if (residencyParts === null) {
      throw new VerificationError("residency must match door:<platform>:<door-id>/epoch:<n>");
    }

    const doorKey = Reflect.get(doorKeys, residencyParts.doorId);
    if (!(doorKey instanceof Uint8Array)) {
      throw new VerificationError(
        `no doorPublicKeys entry for residency Door "${residencyParts.doorId}"`
      );
    }

    for (const [index, cosignerEncoded] of record.cosigners.entries()) {
      const cosignerSig = decodeSignature(cosignerEncoded);
      if (!verify(coreBytes, cosignerSig, doorKey)) {
        throw new VerificationError(
          `cosigner signature at index ${index} failed verification over core bytes`
        );
      }
    }
  }

  const soulBytes = canonicalize(
    soulPayload({
      spec: record.spec,
      seq: record.seq,
      prev: record.prev,
      type: record.type,
      body: record.body,
      residency: record.residency,
      cosigners: record.cosigners
    })
  );
  const soulSig = decodeSignature(record.sig);
  if (!verify(soulBytes, soulSig, options.soulPublicKey)) {
    throw new VerificationError("soul signature verification failed");
  }

  const cid = await computeCid(record);
  if (options.expectedCid !== undefined && options.expectedCid !== cid) {
    throw new VerificationError(`expected CID ${options.expectedCid} but computed ${cid}`);
  }

  return { record, cid };
}
