/**
 * Generates composeSelf golden files for fixtures A and B.
 * Run via: pnpm --filter @npc/runtime generate:goldens
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { composeSelf } from "../src/compose/compose-self.js";
import { buildFixtureA, buildFixtureB } from "../test/helpers/fixtures.js";
import { serializeMemoryIndex } from "../test/helpers/golden-format.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(scriptDir, "../test/golden");

async function writeGolden(
  label: "a" | "b",
  systemPrompt: string,
  memoryIndex: Parameters<typeof serializeMemoryIndex>[0]
): Promise<void> {
  writeFileSync(join(goldenDir, `compose-${label}.systemPrompt.txt`), systemPrompt, "utf8");
  writeFileSync(
    join(goldenDir, `compose-${label}.memoryIndex.json`),
    serializeMemoryIndex(memoryIndex),
    "utf8"
  );
}

async function main(): Promise<void> {
  mkdirSync(goldenDir, { recursive: true });

  const fixtureA = await buildFixtureA();
  const composedA = await composeSelf(fixtureA.store, {
    doorPublicKeys: fixtureA.doorPublicKeys
  });
  await writeGolden("a", composedA.systemPrompt, composedA.memoryIndex);

  const fixtureB = await buildFixtureB();
  const composedB = await composeSelf(fixtureB.store, {
    doorPublicKeys: fixtureB.doorPublicKeys
  });
  await writeGolden("b", composedB.systemPrompt, composedB.memoryIndex);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
