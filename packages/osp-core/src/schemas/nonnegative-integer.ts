import { z } from "zod";

/**
 * Schemas from {@link nonnegativeInteger}. Zod 4 cannot emit `type: integer`
 * for a `Number.isInteger` refinement, so the JSON Schema generator recognizes
 * these instances and sets that keyword itself.
 */
const nonnegativeIntegerSchemas = new WeakSet<object>();

/**
 * Nonnegative integer as Zod 3's `z.number().int().nonnegative()` accepted it.
 *
 * Zod 4's `.int()` is a safe-integer check: it rejects values above
 * `Number.MAX_SAFE_INTEGER` that `Number.isInteger` still accepts, and
 * `z.toJSONSchema` then emits `maximum: 9007199254740991`. Seq and epoch
 * fields keep the previous check so record verification does not change.
 *
 * @returns A number schema that accepts only integers greater than or equal to zero.
 */
export function nonnegativeInteger(): z.ZodType<number> {
  const schema = z
    .number()
    .nonnegative()
    .refine((value: number) => Number.isInteger(value));
  nonnegativeIntegerSchemas.add(schema);
  return schema;
}

/**
 * Reports whether `schema` was created by {@link nonnegativeInteger}.
 *
 * @param schema - A Zod schema instance visited while emitting JSON Schema.
 * @returns True when the generator should emit `{ type: "integer", minimum: 0 }`.
 */
export function isNonnegativeIntegerSchema(schema: object): boolean {
  return nonnegativeIntegerSchemas.has(schema);
}
