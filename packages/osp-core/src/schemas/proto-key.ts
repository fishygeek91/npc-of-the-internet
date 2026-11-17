import { z } from "zod";

/** Own key that JS object assignment (zod `z.record`, naive copies) silently drops. */
export const PROTO_KEY = "__proto__";
const PROTO_KEY_MESSAGE = 'own "__proto__" key is not permitted in OSP records';

/**
 * Deep-walk a raw JSON value (as produced by `JSON.parse`, which creates `__proto__` as an
 * ordinary own property) and reject any object carrying an own `"__proto__"` key.
 *
 * Such keys are dropped by assignment-based copies (zod `z.record`, canonicalization), so the
 * wire bytes of a record could differ from the bytes that were signed and CID-addressed —
 * record bytes would be malleable. Runs on the raw input, before schema parsing copies it.
 */
export function validateNoProtoKeys(value: unknown, ctx: z.RefinementCtx): void {
  walk(value, ctx, []);
}

function walk(value: unknown, ctx: z.RefinementCtx, path: (string | number)[]): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, ctx, [...path, index]);
    });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, PROTO_KEY)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: PROTO_KEY_MESSAGE, path });
  }
  for (const key of Object.keys(value)) {
    walk(Reflect.get(value, key), ctx, [...path, key]);
  }
}
