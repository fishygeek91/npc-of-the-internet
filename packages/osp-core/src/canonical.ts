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
 * Recursively rebuild a value with sorted object keys for canonical JSON.
 */
function sortKeys(value: unknown): JsonValue {
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
    return value.map((item) => sortKeys(item));
  }

  if (isPlainObject(value)) {
    const sorted: { [key: string]: JsonValue } = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }

  throw new EncodingError("canonicalize: unsupported object type");
}

/**
 * Serialize a value to canonical UTF-8 JSON bytes per spec/osp/records.md.
 */
export function canonicalize(value: unknown): Uint8Array {
  const sorted = sortKeys(value);
  const json = JSON.stringify(sorted);
  return new TextEncoder().encode(json);
}
