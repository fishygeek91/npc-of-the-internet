import { decode, encode } from "@ipld/dag-json";
import { CID } from "multiformats/cid";
import { z } from "zod";

import { computeCidFromCanonicalBytes, CidSchema } from "../crypto/cid.js";
import { sign, verify } from "../crypto/ed25519.js";
import { decodeSignature, encodeSignature } from "../encoding/base64url.js";
import { EncodingError, SchemaError, VerificationError } from "../errors.js";

/** Pin manifest format version per spec/osp/ipfs-store.md §4.1. */
export const OSP_PIN_MANIFEST_VERSION = "osp-ipfs/0.1";

/** Unsigned pin manifest (dag-json block without `sig`). */
export type UnsignedPinManifest = {
  osp_pin_manifest: typeof OSP_PIN_MANIFEST_VERSION;
  head: string;
  seq: number;
  genesis: string;
  records: string[];
  generated_at: string;
  prev_manifest?: string;
};

/** Signed pin manifest including soul-key `sig`. */
export type PinManifest = UnsignedPinManifest & {
  sig: string;
};

/** Input to {@link buildUnsignedPinManifest}. */
export type BuildUnsignedPinManifestInput = {
  headCid: string;
  genesisCid: string;
  recordCids: readonly string[];
  seq: number;
  generatedAt: string;
  prevManifestCid?: string | null;
};

/** dag-json encode shape — CID instances become `{"/": "…"}` links. */
type DagJsonPinManifest = {
  osp_pin_manifest: typeof OSP_PIN_MANIFEST_VERSION;
  head: CID;
  seq: number;
  genesis: CID;
  records: CID[];
  generated_at: string;
  prev_manifest?: CID;
  sig?: string;
};

const UnsignedPinManifestSchema = z
  .object({
    osp_pin_manifest: z.literal(OSP_PIN_MANIFEST_VERSION),
    head: CidSchema,
    seq: z.number().int().nonnegative(),
    genesis: CidSchema,
    records: z.array(CidSchema),
    generated_at: z.string().min(1),
    prev_manifest: CidSchema.optional()
  })
  .strict();

const PinManifestSchema = UnsignedPinManifestSchema.extend({
  sig: z.string()
}).strict();

/**
 * Enforce pin manifest structural invariants beyond Zod shape validation.
 *
 * @throws {SchemaError} when records, genesis, head, or seq are inconsistent.
 */
export function assertManifestInvariants(manifest: UnsignedPinManifest | PinManifest): void {
  const { records, genesis, head, seq } = manifest;

  if (records.length === 0) {
    throw new SchemaError("records must contain at least one CID");
  }
  if (records[0] !== genesis) {
    throw new SchemaError("genesis must equal records[0]");
  }
  if (records[records.length - 1] !== head) {
    throw new SchemaError("head must equal the last records entry");
  }
  if (seq !== records.length - 1) {
    throw new SchemaError(`seq must equal records.length - 1 (expected ${records.length - 1})`);
  }
}

/**
 * Convert a dag-json decoded link value to a validated bagu CID string.
 */
function cidLinkToString(value: unknown, field: string): string {
  const cid = CID.asCID(value);
  if (cid == null) {
    throw new SchemaError(`${field} must be a dag-json CID link`);
  }
  const text = cid.toString();
  const parsed = CidSchema.safeParse(text);
  if (!parsed.success) {
    throw new SchemaError(`${field} must be a valid bagu CID string`);
  }
  return parsed.data;
}

/**
 * Build the in-memory unsigned manifest object with CID link fields as strings.
 */
export function buildUnsignedPinManifest(
  input: BuildUnsignedPinManifestInput
): UnsignedPinManifest {
  const head = CidSchema.parse(input.headCid);
  const genesis = CidSchema.parse(input.genesisCid);
  const records = input.recordCids.map((cid, index) => {
    const parsed = CidSchema.safeParse(cid);
    if (!parsed.success) {
      throw new SchemaError(`records[${index}] must be a valid bagu CID string`);
    }
    return parsed.data;
  });

  const manifest: UnsignedPinManifest = {
    osp_pin_manifest: OSP_PIN_MANIFEST_VERSION,
    head,
    seq: input.seq,
    genesis,
    records,
    generated_at: input.generatedAt
  };

  if (input.prevManifestCid !== undefined && input.prevManifestCid !== null) {
    manifest.prev_manifest = CidSchema.parse(input.prevManifestCid);
  }

  assertManifestInvariants(manifest);

  const validated = UnsignedPinManifestSchema.safeParse(manifest);
  if (!validated.success) {
    throw new SchemaError(validated.error.message);
  }

  const { prev_manifest: prevManifest, ...rest } = validated.data;
  if (prevManifest === undefined) {
    return rest;
  }
  return { ...rest, prev_manifest: prevManifest };
}

/**
 * Map a manifest (unsigned or signed) to dag-json encode input with CID link instances.
 */
function toDagJsonManifest(manifest: UnsignedPinManifest | PinManifest): DagJsonPinManifest {
  const dagManifest: DagJsonPinManifest = {
    osp_pin_manifest: manifest.osp_pin_manifest,
    head: CID.parse(manifest.head),
    seq: manifest.seq,
    genesis: CID.parse(manifest.genesis),
    records: manifest.records.map((cid) => CID.parse(cid)),
    generated_at: manifest.generated_at
  };

  if (manifest.prev_manifest !== undefined) {
    dagManifest.prev_manifest = CID.parse(manifest.prev_manifest);
  }

  if ("sig" in manifest && manifest.sig !== undefined) {
    dagManifest.sig = manifest.sig;
  }

  return dagManifest;
}

/**
 * dag-json-encode an unsigned pin manifest (canonical key order, CID links).
 */
export function encodeUnsignedPinManifest(manifest: UnsignedPinManifest): Uint8Array {
  return encode(toDagJsonManifest(manifest));
}

/**
 * dag-json-encode a signed pin manifest.
 */
export function encodePinManifest(manifest: PinManifest): Uint8Array {
  return encode(toDagJsonManifest(manifest));
}

/**
 * Decode dag-json manifest bytes and validate structure with Zod.
 */
export function decodePinManifest(bytes: Uint8Array): PinManifest {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EncodingError(`failed to decode pin manifest dag-json: ${message}`);
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new SchemaError("pin manifest must be a JSON object");
  }

  const ospPinManifest = Reflect.get(decoded, "osp_pin_manifest");
  const head = Reflect.get(decoded, "head");
  const seq = Reflect.get(decoded, "seq");
  const genesis = Reflect.get(decoded, "genesis");
  const records = Reflect.get(decoded, "records");
  const generatedAt = Reflect.get(decoded, "generated_at");
  const prevManifest = Reflect.get(decoded, "prev_manifest");
  const sig = Reflect.get(decoded, "sig");

  if (!Array.isArray(records)) {
    throw new SchemaError("records must be an array");
  }

  const recordCids: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    recordCids.push(cidLinkToString(entry, `records[${index}]`));
  }

  const manifestBase = {
    osp_pin_manifest: OSP_PIN_MANIFEST_VERSION as typeof OSP_PIN_MANIFEST_VERSION,
    head: cidLinkToString(head, "head"),
    seq: typeof seq === "number" ? seq : -1,
    genesis: cidLinkToString(genesis, "genesis"),
    records: recordCids,
    generated_at: typeof generatedAt === "string" ? generatedAt : "",
    sig: typeof sig === "string" ? sig : ""
  };

  if (typeof ospPinManifest !== "string" || ospPinManifest !== OSP_PIN_MANIFEST_VERSION) {
    throw new SchemaError(`osp_pin_manifest must be "${OSP_PIN_MANIFEST_VERSION}"`);
  }

  const candidate =
    prevManifest === undefined
      ? manifestBase
      : {
          ...manifestBase,
          prev_manifest: cidLinkToString(prevManifest, "prev_manifest")
        };

  try {
    decodeSignature(candidate.sig);
  } catch (error) {
    if (error instanceof EncodingError) {
      throw new SchemaError(error.message);
    }
    throw error;
  }

  const validated = PinManifestSchema.safeParse(candidate);
  if (!validated.success) {
    throw new SchemaError(validated.error.message);
  }

  const { prev_manifest: validatedPrev, ...validatedRest } = validated.data;
  const result =
    validatedPrev === undefined
      ? validatedRest
      : { ...validatedRest, prev_manifest: validatedPrev };

  assertManifestInvariants(result);

  return result;
}

/**
 * Soul-sign an unsigned manifest and return the signed in-memory form.
 */
export function signPinManifest(
  unsigned: UnsignedPinManifest,
  soulPrivateKey: Uint8Array
): PinManifest {
  const unsignedBytes = encodeUnsignedPinManifest(unsigned);
  const signature = encodeSignature(sign(unsignedBytes, soulPrivateKey));

  const signed: PinManifest = {
    ...unsigned,
    sig: signature
  };

  const validated = PinManifestSchema.safeParse(signed);
  if (!validated.success) {
    throw new SchemaError(validated.error.message);
  }

  const { prev_manifest: validatedPrev, ...validatedRest } = validated.data;
  if (validatedPrev === undefined) {
    return validatedRest;
  }
  return { ...validatedRest, prev_manifest: validatedPrev };
}

/**
 * Verify a signed manifest's soul signature and return its content CID.
 */
export async function verifyPinManifest(
  manifest: PinManifest,
  soulPublicKey: Uint8Array
): Promise<{ cid: string }> {
  const { sig, ...unsigned } = manifest;
  const unsignedBytes = encodeUnsignedPinManifest(unsigned);
  const signature = decodeSignature(sig);

  if (!verify(unsignedBytes, signature, soulPublicKey)) {
    throw new VerificationError("pin manifest soul signature verification failed");
  }

  const manifestBytes = encodePinManifest(manifest);
  const cid = await computeCidFromCanonicalBytes(manifestBytes);
  return { cid };
}

/**
 * Compute the manifest block CID from a signed in-memory manifest.
 */
export async function computeManifestCid(manifest: PinManifest): Promise<string> {
  return computeCidFromCanonicalBytes(encodePinManifest(manifest));
}

/**
 * Compute the manifest block CID from pre-encoded dag-json bytes.
 */
export async function computeManifestCidFromBytes(bytes: Uint8Array): Promise<string> {
  return computeCidFromCanonicalBytes(bytes);
}
