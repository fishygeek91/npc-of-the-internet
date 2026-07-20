import { readFileSync } from "node:fs";
import * as path from "node:path";

import { defaultCharterPath } from "./repo-root.js";

/** Exit code for usage errors and I/O failures. */
export const EXIT_USAGE = 2;

/**
 * Resolve the charter file path: explicit override, in-repo default, or failure.
 */
export function resolveCharterPath(charterOverride: string | undefined): string {
  if (charterOverride !== undefined) {
    return path.resolve(charterOverride);
  }

  const defaultPath = defaultCharterPath();
  if (defaultPath === null) {
    throw new CharterResolutionError(
      "charter not found: run from the repository or pass --charter <path>"
    );
  }

  return defaultPath;
}

/**
 * Read the full UTF-8 charter contents. Fails when the file is missing or empty.
 */
export function readCharterContents(charterPath: string): string {
  let contents: string;
  try {
    contents = readFileSync(charterPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CharterResolutionError(`failed to read charter at ${charterPath}: ${message}`);
  }

  if (contents.length === 0) {
    throw new CharterResolutionError(`charter file is empty: ${charterPath}`);
  }

  return contents;
}

/** Thrown when the charter cannot be resolved or read. */
export class CharterResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharterResolutionError";
  }
}
