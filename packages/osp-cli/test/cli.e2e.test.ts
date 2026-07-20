import { canonicalize, computeCidFromCanonicalBytes } from "@npc/osp-core";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "dist", "cli.js");
const repoRoot = path.resolve(packageRoot, "..", "..");
const charterPath = path.join(repoRoot, "spec", "osp", "genesis.md");

/** Run the built CLI and return stdout, stderr, and exit code. */
function runCli(args: string[], cwd?: string): { stdout: string; stderr: string; status: number } {
  const result = execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return { stdout: result, stderr: "", status: 0 };
}

/** Run the built CLI allowing non-zero exit codes. */
function runCliAllowFail(
  args: string[],
  cwd?: string
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
      status: execError.status ?? 1
    };
  }
}

/** Parse `Genesis CID: …` from init stdout. */
function parseGenesisCid(stdout: string): string {
  const match = stdout.match(/^Genesis CID: (.+)$/m);
  if (match === null || match[1] === undefined) {
    throw new Error(`genesis CID not found in init output:\n${stdout}`);
  }
  return match[1].trim();
}

describe("osp CLI e2e", () => {
  it("init → verify → log → show → tamper → verify fails", async () => {
    const soulDir = await mkdtemp(path.join(tmpdir(), "osp-cli-e2e-"));

    try {
      const init = runCli(["init", soulDir, "--charter", charterPath], repoRoot);
      expect(init.status).toBe(0);
      expect(init.stdout).toMatch(/^Soul public key: /m);
      const genesisCid = parseGenesisCid(init.stdout);

      const soulKey = await readFile(path.join(soulDir, "soul.key"), "utf8");
      const chainContents = await readFile(path.join(soulDir, "chain.jsonl"), "utf8");
      expect(chainContents).not.toContain(soulKey.trim());
      expect(chainContents).not.toContain("soul.key");

      const blobsDir = path.join(soulDir, "blobs");
      const blobFiles = await import("node:fs/promises").then((fs) => fs.readdir(blobsDir));
      for (const blob of blobFiles) {
        const blobContents = await readFile(path.join(blobsDir, blob), "utf8");
        expect(blobContents).not.toContain(soulKey.trim());
      }

      const verifyOk = runCliAllowFail(["verify", soulDir], repoRoot);
      expect(verifyOk.status).toBe(0);

      const log = runCli(["log", soulDir], repoRoot);
      expect(log.status).toBe(0);
      expect(
        log.stdout.split("\n").filter((line) => line.length > 0).length
      ).toBeGreaterThanOrEqual(1);
      expect(log.stdout).toMatch(/^0 genesis /m);

      const show = runCli(["show", genesisCid, "--dir", soulDir], repoRoot);
      expect(show.status).toBe(0);
      expect(show.stdout).toContain('"type": "genesis"');

      const chainPath = path.join(soulDir, "chain.jsonl");
      const blobPath = path.join(soulDir, "blobs", genesisCid);
      const record = JSON.parse((await readFile(blobPath, "utf8")).trim()) as { sig: string };
      const sig = record.sig;
      record.sig = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
      const tamperedBytes = canonicalize(record);
      const tamperedCid = await computeCidFromCanonicalBytes(tamperedBytes);
      await writeFile(path.join(soulDir, "blobs", tamperedCid), tamperedBytes);
      await writeFile(chainPath, Buffer.concat([tamperedBytes, Buffer.from("\n")]));

      const verifyBad = runCliAllowFail(["verify", soulDir], repoRoot);
      expect(verifyBad.status).toBe(1);
    } finally {
      await rm(soulDir, { recursive: true, force: true });
    }
  });
});
