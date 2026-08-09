import { z } from "zod";

const DAG_JSON_RESERVED_KEY = "/";
const DAG_JSON_RESERVED_MESSAGE = 'dag-json reserved form: sole key "/"';

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

/** True when a plain object has exactly one own enumerable key and it is `"/"`. */
function isDagJsonReservedLinkObject(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === DAG_JSON_RESERVED_KEY;
}

/**
 * Deep-walk a JSON value tree and reject dag-json link reserved forms.
 * Skips non-plain objects; recurses into arrays and plain object values.
 */
function walkDagJsonReserved(
  value: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[]
): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkDagJsonReserved(item, ctx, [...path, index]);
    });
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  if (isDagJsonReservedLinkObject(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: DAG_JSON_RESERVED_MESSAGE,
      path
    });
  }

  for (const [key, child] of Object.entries(value)) {
    walkDagJsonReserved(child, ctx, [...path, key]);
  }
}

/**
 * Reject any nested plain object whose sole key is `"/"` (dag-json link form).
 * Used at create and verify time via {@link RecordSchema}.
 */
export function validateDagJsonReservedForm(value: unknown, ctx: z.RefinementCtx): void {
  walkDagJsonReserved(value, ctx, []);
}
