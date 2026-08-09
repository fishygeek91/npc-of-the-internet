import {
  canonicalize,
  computeCidFromCanonicalBytes,
  createRecord,
  decodeBase64Url,
  encodePublicKey,
  FileSoulStore,
  generateKeypair,
  signCore
} from "@npc/osp-core";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { runVerify } from "../src/commands/verify.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "dist", "cli.js");
const repoRoot = path.resolve(packageRoot, "..", "..");
const charterPath = path.join(repoRoot, "spec", "osp", "genesis.md");
const RESIDENCY = "door:discord:g/epoch:1";
const DOOR_ID = "discord:g";

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

/** Append a cosigned memory shard to an initialized soulchain directory. */
async function appendCosignedShard(
  soulDir: string,
  doorPublicKey: Uint8Array,
  doorPrivateKey: Uint8Array
): Promise<void> {
  const soulKeyEncoded = (await readFile(path.join(soulDir, "soul.key"), "utf8")).trim();
  const soulPrivateKey = decodeBase64Url(soulKeyEncoded);

  const store = await FileSoulStore.open(soulDir, { doorPublicKeys: { [DOOR_ID]: doorPublicKey } });
  try {
    const head = await store.head();
    if (head === null) {
      throw new Error("expected head after init");
    }

    const fields = {
      seq: 1,
      prev: head.cid,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: "E2E cosigned shard.",
        distilled_at: "2026-07-20T00:00:00.000Z"
      },
      residency: RESIDENCY
    };
    const cosig = signCore(fields, doorPrivateKey);
    const { record } = await createRecord({
      ...fields,
      cosigners: [cosig],
      soulPrivateKey
    });
    await store.append(record);
  } finally {
    await store.close();
  }
}

describe("osp CLI e2e", () => {
  beforeAll(() => {
    if (!existsSync(cliPath)) {
      throw new Error(
        "dist/cli.js missing — run `pnpm --filter @npc/osp-cli build` first (CI/pnpm check do this)"
      );
    }
  });

  it("exits 2 when init has no directory argument", () => {
    const result = runCliAllowFail(["init"], repoRoot);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/init requires a target directory/);
  });

  it("exits 2 when verify path does not exist", () => {
    const missingDir = path.join(tmpdir(), `osp-missing-${Date.now()}`);
    const result = runCliAllowFail(["verify", missingDir], repoRoot);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Soulchain directory not found/);
  });

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
      // Flip the first character (not the last): last-char A/B swaps can produce
      // invalid base64url trailing bits and surface as schema_violation instead of bad_soul_sig.
      const first = sig.charAt(0);
      const flipped = first === "A" ? "B" : "A";
      record.sig = `${flipped}${sig.slice(1)}`;
      const tamperedBytes = canonicalize(record);
      const tamperedCid = await computeCidFromCanonicalBytes(tamperedBytes);
      await writeFile(path.join(soulDir, "blobs", tamperedCid), tamperedBytes);
      await writeFile(chainPath, Buffer.concat([tamperedBytes, Buffer.from("\n")]));

      const verifyBad = runCliAllowFail(["verify", soulDir], repoRoot);
      expect(verifyBad.status).toBe(1);
      expect(verifyBad.stdout).toMatch(/\[bad_soul_sig\]/);
    } finally {
      await rm(soulDir, { recursive: true, force: true });
    }
  });

  it("refuses init when soul.key already exists and leaves key bytes unchanged", async () => {
    const soulDir = await mkdtemp(path.join(tmpdir(), "osp-cli-init-key-"));
    const soulKeyPath = path.join(soulDir, "soul.key");
    const sentinel = Buffer.from("sentinel-soul-key-bytes-do-not-clobber", "utf8");

    try {
      await writeFile(soulKeyPath, sentinel, { mode: 0o600 });
      const beforeBytes = await readFile(soulKeyPath);

      const result = runCliAllowFail(["init", soulDir, "--charter", charterPath], repoRoot);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/soul\.key already exists/);

      const afterBytes = await readFile(soulKeyPath);
      expect(afterBytes.equals(beforeBytes)).toBe(true);
    } finally {
      await rm(soulDir, { recursive: true, force: true });
    }
  });

  it("refuses init when chain.jsonl exists without soul.key", async () => {
    const soulDir = await mkdtemp(path.join(tmpdir(), "osp-cli-init-chain-"));
    const chainPath = path.join(soulDir, "chain.jsonl");
    const sentinel = Buffer.from('{"seq":0,"note":"preexisting-chain"}\n', "utf8");

    try {
      await writeFile(chainPath, sentinel);
      const beforeBytes = await readFile(chainPath);

      const result = runCliAllowFail(["init", soulDir, "--charter", charterPath], repoRoot);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/chain\.jsonl already exists/);

      const afterBytes = await readFile(chainPath);
      expect(afterBytes.equals(beforeBytes)).toBe(true);
      expect(existsSync(path.join(soulDir, "soul.key"))).toBe(false);
    } finally {
      await rm(soulDir, { recursive: true, force: true });
    }
  });

  it("verify on empty directory exits 2 and does not create chain layout", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "osp-cli-verify-empty-"));

    try {
      const result = runCliAllowFail(["verify", emptyDir], repoRoot);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/chain file does not exist|blobs directory does not exist/);
      expect(existsSync(path.join(emptyDir, "chain.jsonl"))).toBe(false);
      expect(existsSync(path.join(emptyDir, "blobs"))).toBe(false);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("verify reports torn trailing line as exit 1 without mutating chain", async () => {
    const soulDir = await mkdtemp(path.join(tmpdir(), "osp-cli-verify-torn-"));

    try {
      const init = runCli(["init", soulDir, "--charter", charterPath], repoRoot);
      expect(init.status).toBe(0);

      const chainPath = path.join(soulDir, "chain.jsonl");
      const chainBytesBefore = await readFile(chainPath);
      const partialSuffix = Buffer.from('{"seq":99,"partial":true');
      await writeFile(chainPath, Buffer.concat([chainBytesBefore, partialSuffix]));

      const result = runCliAllowFail(["verify", soulDir], repoRoot);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/truncated trailing line/);

      const chainBytesAfter = await readFile(chainPath);
      expect(chainBytesAfter.equals(Buffer.concat([chainBytesBefore, partialSuffix]))).toBe(true);
    } finally {
      await rm(soulDir, { recursive: true, force: true });
    }
  });

  it("verify accepts --door-key for cosigned shards and rejects wrong keys", async () => {
    const soulDir = await mkdtemp(path.join(tmpdir(), "osp-cli-door-key-"));
    const door = generateKeypair();
    const wrongDoor = generateKeypair();

    try {
      const init = runCli(["init", soulDir, "--charter", charterPath], repoRoot);
      expect(init.status).toBe(0);

      await appendCosignedShard(soulDir, door.publicKey, door.privateKey);

      const doorKey = `${DOOR_ID}=${encodePublicKey(door.publicKey)}`;
      const wrongKey = `${DOOR_ID}=${encodePublicKey(wrongDoor.publicKey)}`;

      expect(await runVerify({ dir: soulDir, doorKeys: [doorKey] })).toBe(0);
      expect(await runVerify({ dir: soulDir, doorKeys: [wrongKey] })).toBe(1);

      const verifyOkCli = runCliAllowFail(["verify", soulDir, "--door-key", doorKey], repoRoot);
      expect(verifyOkCli.status).toBe(0);

      const verifyBadCli = runCliAllowFail(["verify", soulDir, "--door-key", wrongKey], repoRoot);
      expect(verifyBadCli.status).toBe(1);
      expect(verifyBadCli.stdout).toMatch(/\[missing_cosigner\]/);
    } finally {
      await rm(soulDir, { recursive: true, force: true });
    }
  });
});
