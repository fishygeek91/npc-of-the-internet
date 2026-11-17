import { describe, expect, it } from "vitest";

import { RECORD_TYPES, RecordSchemaBase, type RecordType } from "../src/index.js";

/**
 * Pull the `type` literal off each `RecordSchemaBase` option.
 * Throws when the discriminator is not a single string literal.
 */
function schemaRecordTypes(): string[] {
  const types: string[] = [];
  for (const option of RecordSchemaBase.options) {
    const values = [...option.shape.type.values];
    if (values.length !== 1) {
      throw new Error(`expected one type literal, got ${String(values.length)}`);
    }
    const value = values[0];
    if (typeof value !== "string") {
      throw new Error("record type discriminator is not a string literal");
    }
    types.push(value);
  }
  return types;
}

describe("RECORD_TYPES", () => {
  it("equals the envelope schema discriminator options", () => {
    const fromSchema = schemaRecordTypes();
    const exported: readonly RecordType[] = RECORD_TYPES;
    expect([...exported]).toEqual(fromSchema);
    expect(new Set(exported).size).toBe(exported.length);
    expect(exported).toContain("tombstone");
  });
});
