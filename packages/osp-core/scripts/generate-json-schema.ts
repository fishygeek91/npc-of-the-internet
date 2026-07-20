/**
 * Emits JSON Schema for OSP record types from Zod schemas.
 * Run via: pnpm --filter @npc/osp-core generate:schema
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import { EnvelopeFieldsSchema, RecordSchemaBase } from "../src/schemas/index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(scriptDir, "../../../spec/osp/schema");

/** Pretty-print JSON Schema to spec/osp/schema/. */
function writeSchema(filename: string, schema: object): void {
  const path = join(schemaDir, filename);
  const json = `${JSON.stringify(schema, null, 2)}\n`;
  writeFileSync(path, json, "utf8");
}

mkdirSync(schemaDir, { recursive: true });

// RecordSchemaBase omits superRefine rules (prev/residency/cosigners) — see records.md prose.
const recordsSchema = zodToJsonSchema(RecordSchemaBase, {
  name: "OspRecord",
  $refStrategy: "none"
});

writeSchema("records.json", recordsSchema);

const envelopeSchema = zodToJsonSchema(EnvelopeFieldsSchema, {
  name: "EnvelopeFields",
  $refStrategy: "none"
});

writeSchema("envelope.json", envelopeSchema);
