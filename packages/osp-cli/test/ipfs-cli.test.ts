import {
  canonicalize,
  computeCid,
  createRecord,
  encodeBase64Url,
  encodePublicKey,
  generateKeypair,
  importSoulchainCar,
  IpfsSoulStore,
  verifyChain,
  type Ed25519Keypair
} from "@npc/osp-core";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { runExportCar } from "../src/commands/export-car.js";
import { runManifest } from "../src/commands/manifest.js";
import { runVerifyFromIpfs } from "../src/commands/verify-from-ipfs.js";
import type { BlockFetcher } from "../src/gateway-fetch.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageRoot, "dist", "cli.js");
const RESIDENCY = "door:discord:g/epoch:1";

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

/** Create a unique temporary directory. */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Build and return a signed genesis record. */
async function createGenesisRecord(soul: Ed25519Keypair) {
  return createRecord({
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/** Build a signed memory candidate record. */
async function createMemoryCandidateRecord(
  soul: Ed25519Keypair,
  seq: number,
  prev: string,
  text: string
) {
  return createRecord({
    seq,
    prev,
    type: "memory",
    body: {
      kind: "candidate",
      text,
      proposed_at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
}

/**
 * Prepare an IpfsSoulStore directory with genesis + one memory and a soul.key.
 * Returns head CID for gateway-style verification tests.
 */
async function prepareIpfsStore(dir: string): Promise<{ headCid: string }> {
  const soul = generateKeypair();
  await writeFile(path.join(dir, "soul.key"), encodeBase64Url(soul.privateKey), {
    mode: 0o600
  });

  const store = await IpfsSoulStore.open(dir);
  try {
    const genesis = await createGenesisRecord(soul);
    const genesisAppend = await store.append(genesis.record);
    const memory = await createMemoryCandidateRecord(soul, 1, genesisAppend.cid, "CLI memory.");
    await store.append(memory.record);

    const head = await store.head();
    if (head === null) {
      throw new Error("expected head after append");
    }

    return { headCid: head.cid };
  } finally {
    await store.close();
  }
}

/** Map-backed fetcher that returns opaque record bytes by CID (no network). */
function mapFetcher(blocks: ReadonlyMap<string, Uint8Array>): BlockFetcher {
  return {
    async fetchBlock(cid: string): Promise<Uint8Array> {
      const bytes = blocks.get(cid);
      if (bytes === undefined) {
        throw new Error(`missing block for ${cid}`);
      }
      return bytes;
    }
  };
}

/** Load canonicalize(record) bytes keyed by CID from an IpfsSoulStore. */
async function loadCanonicalBlocks(dir: string): Promise<Map<string, Uint8Array>> {
  const blocks = new Map<string, Uint8Array>();
  const store = await IpfsSoulStore.openReadOnly(dir);
  try {
    for await (const record of store.iterate()) {
      const bytes = canonicalize(record);
      const cid = await computeCid(record);
      blocks.set(cid, bytes);
    }
  } finally {
    await store.close();
  }
  return blocks;
}

describe("osp IPFS CLI (T7.1c)", () => {
  beforeAll(() => {
    if (!existsSync(cliPath)) {
      throw new Error(
        "dist/cli.js missing — run `pnpm --filter @npc/osp-cli build` first (CI/pnpm check do this)"
      );
    }
  });

  it("manifest and export-car via library + CLI binary", async () => {
    const dir = await makeTempDir("osp-cli-ipfs-manifest-");
    const outDir = await makeTempDir("osp-cli-ipfs-car-out-");

    try {
      await prepareIpfsStore(dir);

      const generatedAt = "2026-07-28T00:00:00.000Z";
      const manifestResult = await runManifest({ dir, generatedAt });
      expect(manifestResult.manifestCid).toMatch(/^bagu/);

      const cliManifest = runCliAllowFail(
        ["manifest", dir, "--generated-at", generatedAt],
        packageRoot
      );
      expect(cliManifest.status).toBe(0);
      expect(cliManifest.stdout.trim()).toBe(manifestResult.manifestCid);

      const carPath = path.join(outDir, "soulchain-1.car");
      const exportResult = await runExportCar({
        dir,
        out: carPath,
        generatedAt
      });
      expect(exportResult.manifestCid).toBe(manifestResult.manifestCid);
      expect(existsSync(carPath)).toBe(true);

      const cliExport = runCliAllowFail(
        ["export-car", dir, "--out", path.join(outDir, "cli.car"), "--generated-at", generatedAt],
        packageRoot
      );
      expect(cliExport.status).toBe(0);
      expect(cliExport.stdout).toContain(`Manifest CID: ${manifestResult.manifestCid}`);

      const importDir = await makeTempDir("osp-cli-ipfs-import-");
      try {
        await importSoulchainCar({ carPathOrBytes: carPath, outDir: importDir });
        const imported = await IpfsSoulStore.openReadOnly(importDir);
        try {
          const verified = await verifyChain(imported);
          expect(verified.valid).toBe(true);
        } finally {
          await imported.close();
        }
      } finally {
        await rm(importDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("verify --from-ipfs with injectable fetcher (no network)", async () => {
    const dir = await makeTempDir("osp-cli-from-ipfs-");

    try {
      const { headCid } = await prepareIpfsStore(dir);
      const blocks = await loadCanonicalBlocks(dir);

      expect(await runVerifyFromIpfs({ headCid, fetcher: mapFetcher(blocks) })).toBe(0);

      const badFetcher = await runVerifyFromIpfs({
        headCid,
        fetcher: {
          async fetchBlock(): Promise<Uint8Array> {
            throw new Error("gateway down");
          }
        }
      });
      expect(badFetcher).toBe(2);

      const usage = runCliAllowFail(["verify", "--from-ipfs"], packageRoot);
      expect(usage.status).toBe(2);
      expect(usage.stderr).toMatch(/verify --from-ipfs requires a head CID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verify --from-ipfs rejects a tampered block body", async () => {
    const dir = await makeTempDir("osp-cli-from-ipfs-tamper-");

    try {
      const { headCid } = await prepareIpfsStore(dir);
      const blocks = await loadCanonicalBlocks(dir);

      const headBytes = blocks.get(headCid);
      if (headBytes === undefined) {
        throw new Error("missing head bytes");
      }
      const tampered = new Uint8Array(headBytes);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;

      const exitCode = await runVerifyFromIpfs({
        headCid,
        fetcher: {
          async fetchBlock(cid: string): Promise<Uint8Array> {
            if (cid === headCid) {
              return tampered;
            }
            const bytes = blocks.get(cid);
            if (bytes === undefined) {
              throw new Error(`missing ${cid}`);
            }
            return bytes;
          }
        }
      });
      expect(exitCode).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
