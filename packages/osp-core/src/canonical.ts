import { EncodingError } from "./errors.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Returns true for plain objects created via `{}` or `new Object()`.
 * Arrays, null, and class instances are excluded.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate and convert an unknown value to a JSON-compatible tree.
 * Does not rely on object insertion order for later serialization.
 */
function toJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  const valueType = typeof value;

  if (valueType === "boolean" || valueType === "string") {
    return value as boolean | string;
  }

  if (valueType === "number") {
    const numberValue = value as number;
    if (!Number.isFinite(numberValue)) {
      throw new EncodingError("canonicalize: non-finite number");
    }
    return numberValue;
  }

  if (
    valueType === "undefined" ||
    valueType === "bigint" ||
    valueType === "function" ||
    valueType === "symbol"
  ) {
    throw new EncodingError(`canonicalize: unsupported type ${valueType}`);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isPlainObject(value)) {
    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      result[key] = toJsonValue(value[key]);
    }
    return result;
  }

  throw new EncodingError("canonicalize: unsupported object type");
}

/**
 * Emit canonical JSON text with UTF-16 code-unit key order.
 * Builds the string directly so integer-like keys are not reordered by JS property order.
 */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => {
    const child = value[key];
    if (child === undefined) {
      throw new EncodingError("canonicalize: missing object value");
    }
    return `${JSON.stringify(key)}:${canonicalJson(child)}`;
  });
  return `{${entries.join(",")}}`;
}

/**
 * Serialize a value to canonical UTF-8 JSON bytes per spec/osp/records.md.
 */
export function canonicalize(value: unknown): Uint8Array {
  const json = canonicalJson(toJsonValue(value));
  return new TextEncoder().encode(json);
}
