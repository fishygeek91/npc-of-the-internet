/**
 * Emits JSON Schema for OSP record types from Zod schemas.
 * Run via: pnpm --filter @npc/osp-core generate:schema
 *
 * Zod 4's `z.toJSONSchema` replaces `zod-to-json-schema` (Zod 3 only).
 * `reused: "inline"` inlines nested schemas, matching the previous
 * `$refStrategy: "none"`. The `override` callback adjusts three emissions
 * that would otherwise change the committed documents without changing which
 * JSON values validate:
 *
 * - {@link nonnegativeInteger} is a `Number.isInteger` refinement. Zod emits
 *   `type: number` for that check; the override sets `type: integer` and drops
 *   a safe-integer `maximum`, which is the previous `{ type: "integer", minimum: 0 }`.
 * - `z.record(z.string(), …)` emits `propertyNames: { type: "string" }`. Every
 *   JSON object key is already a string, so the keyword accepts the same set
 *   and is removed.
 * - Array keywords are ordered `type`, `items`, `minItems` so the document
 *   matches the previous generator. Keyword order is not significant.
 *
 * The root wrapper (below) only restores the historical document shape
 * `{ "$ref", "definitions", "$schema" }`. It does not add or drop keywords.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { EnvelopeFieldsSchema, RecordSchemaBase } from "../src/schemas/index.js";
import { isNonnegativeIntegerSchema } from "../src/schemas/nonnegative-integer.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(scriptDir, "../../../spec/osp/schema");

/** Draft-07 document URI written on every generated schema. */
const DRAFT_07_SCHEMA = "http://json-schema.org/draft-07/schema#";

/** Keyword order `zod-to-json-schema` used for array schemas. */
const ARRAY_KEYWORD_ORDER = ["type", "items", "minItems", "maxItems", "additionalItems"] as const;

/**
 * One JSON Schema node. The index signature matches Zod's schema object so
 * generator options can edit it in place.
 */
type JsonSchemaNode = {
  [key: string]: unknown;
  $schema?: string;
  $ref?: string;
  definitions?: Record<string, JsonSchemaNode>;
  type?: string | readonly string[];
  propertyNames?: unknown;
  maximum?: number;
};

/**
 * True when `value` is a JSON Schema object node (not an array or null).
 *
 * @param value - A keyword value encountered while walking a schema.
 */
function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop `propertyNames: { type: "string" }` with no other constraints.
 * JSON object keys are strings, so the keyword does not change validation.
 *
 * @param node - Schema node that may describe a `z.record`.
 */
function stripUnconstrainedPropertyNames(node: JsonSchemaNode): void {
  if (!isSchemaNode(node.propertyNames)) {
    return;
  }
  const keys = Object.keys(node.propertyNames);
  if (keys.length === 1 && keys[0] === "type" && node.propertyNames.type === "string") {
    delete node.propertyNames;
  }
}

/**
 * Put array keywords in the historical order. Other keywords keep their order.
 *
 * @param node - Schema node visited by `z.toJSONSchema`'s override.
 */
function orderArrayKeywords(node: JsonSchemaNode): void {
  if (node.type !== "array") {
    return;
  }
  const preferred = new Set<string>(ARRAY_KEYWORD_ORDER);
  const ordered: string[] = [];
  for (const key of ARRAY_KEYWORD_ORDER) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      ordered.push(key);
    }
  }
  for (const key of Object.keys(node)) {
    if (!preferred.has(key)) {
      ordered.push(key);
    }
  }
  const current = Object.keys(node);
  const alreadyOrdered = ordered.every((key, index) => key === current[index]);
  if (alreadyOrdered) {
    return;
  }
  const saved = new Map<string, unknown>();
  for (const key of ordered) {
    saved.set(key, node[key]);
  }
  for (const key of current) {
    delete node[key];
  }
  for (const key of ordered) {
    node[key] = saved.get(key);
  }
}

/**
 * Adjust one node so draft-07 output matches the previous generator where
 * Zod 4's defaults are equivalent for JSON values.
 *
 * @param zodSchema - Zod schema currently being converted.
 * @param jsonSchema - JSON Schema node Zod built for `zodSchema`.
 */
function adjustDraft07Node(zodSchema: object, jsonSchema: JsonSchemaNode): void {
  if (isNonnegativeIntegerSchema(zodSchema)) {
    jsonSchema.type = "integer";
    delete jsonSchema.maximum;
  }
  stripUnconstrainedPropertyNames(jsonSchema);
  orderArrayKeywords(jsonSchema);
}

/**
 * Copy `generated` without its `$schema` keyword. `JSON.stringify` also skips
 * Zod's non-enumerable `~standard` property, which `Object.keys` never sees.
 *
 * @param generated - `z.toJSONSchema` result for one named schema.
 */
function definitionBody(generated: JsonSchemaNode): JsonSchemaNode {
  const definition: JsonSchemaNode = {};
  for (const key of Object.keys(generated)) {
    if (key === "$schema") {
      continue;
    }
    definition[key] = generated[key];
  }
  return definition;
}

/**
 * Rebuild the root document `zod-to-json-schema` emitted for a named schema:
 * `$ref` into `definitions`, then `$schema` last. Nested schemas stay inlined.
 *
 * @param name - Definition key and `$ref` target (`OspRecord`, `EnvelopeFields`).
 * @param generated - `z.toJSONSchema` result (`target: "draft-07"`).
 */
function wrapNamedDraft07Schema(name: string, generated: JsonSchemaNode): JsonSchemaNode {
  return {
    $ref: `#/definitions/${name}`,
    definitions: {
      [name]: definitionBody(generated)
    },
    $schema: DRAFT_07_SCHEMA
  };
}

/**
 * Convert a Zod schema to the repo's draft-07 document and write it.
 *
 * @param filename - File name under `spec/osp/schema/`.
 * @param name - Root definition name.
 * @param schema - Schema to convert. Refinements JSON Schema cannot express
 *   (chain-link rules, signature bytes) are omitted, matching the previous generator.
 */
function writeSchema(filename: string, name: string, schema: z.ZodType): void {
  const generated = z.toJSONSchema(schema, {
    target: "draft-07",
    reused: "inline",
    override: (ctx) => {
      adjustDraft07Node(ctx.zodSchema, ctx.jsonSchema);
    }
  });
  const path = join(schemaDir, filename);
  const json = `${JSON.stringify(wrapNamedDraft07Schema(name, generated), null, 2)}\n`;
  writeFileSync(path, json, "utf8");
}

mkdirSync(schemaDir, { recursive: true });

// RecordSchemaBase omits superRefine rules (prev/residency/cosigners) — see records.md prose.
writeSchema("records.json", "OspRecord", RecordSchemaBase);
writeSchema("envelope.json", "EnvelopeFields", EnvelopeFieldsSchema);
