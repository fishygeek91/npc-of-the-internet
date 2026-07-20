import { existsSync } from "node:fs";
import * as path from "node:path";

const WORKSPACE_MARKER = "pnpm-workspace.yaml";
const CHARTER_RELATIVE = path.join("spec", "osp", "genesis.md");

/**
 * Walk upward from `startDir` to find the monorepo root (pnpm workspace + genesis charter).
 * Returns null when not inside the NPC of the Internet repository.
 */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);

  for (;;) {
    const workspaceFile = path.join(current, WORKSPACE_MARKER);
    const charterFile = path.join(current, CHARTER_RELATIVE);
    if (existsSync(workspaceFile) && existsSync(charterFile)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Default charter path inside the repository, or null when not in-repo. */
export function defaultCharterPath(startDir?: string): string | null {
  const root = findRepoRoot(startDir);
  if (root === null) {
    return null;
  }
  return path.join(root, CHARTER_RELATIVE);
}
