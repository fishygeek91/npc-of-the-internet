import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeCidFromCanonicalBytes, FileSoulStore } from "@npc/osp-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChainView } from "../src/chain-view.js";
import { createAtlasServer, registerShutdownSignals } from "../src/server.js";
import { fixtureDoorPublicKeys, MULTI_RESIDENCY_FIXTURE_DIR } from "./helpers/fixture-meta.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function fixtureCopy(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  await cp(MULTI_RESIDENCY_FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

/** Remove the blob of the second chain record (structural read → unreadable). */
async function breakMidBlob(dir: string): Promise<{ blobPath: string; blobBytes: Buffer }> {
  const lines = (await readFile(join(dir, "chain.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  const midLine = lines[1];
  if (midLine === undefined) {
    throw new Error("fixture chain too short");
  }
  const cid = await computeCidFromCanonicalBytes(new TextEncoder().encode(midLine));
  const blobPath = join(dir, "blobs", cid);
  const blobBytes = await readFile(blobPath);
  await rm(blobPath);
  return { blobPath, blobBytes };
}

describe("ChainView load sharing", () => {
  it("concurrent snapshots of one fingerprint share a single load", async () => {
    const dir = await fixtureCopy("atlas-stampede-");
    const openSpy = vi.spyOn(FileSoulStore, "openReadOnly");
    const view = new ChainView({ chainDir: dir, doorPublicKeys: fixtureDoorPublicKeys() });

    const snaps = await Promise.all(Array.from({ length: 25 }, () => view.snapshot()));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const first = snaps[0];
    expect(first?.unreadable).toBeUndefined();
    expect(first?.records.length).toBeGreaterThan(0);
    for (const snap of snaps) {
      expect(snap).toBe(first);
    }

    // Cached afterwards: no further load for the same fingerprint.
    await view.snapshot();
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("concurrent snapshots of an unreadable chain share a single load", async () => {
    const dir = await fixtureCopy("atlas-stampede-bad-");
    await breakMidBlob(dir);
    const openSpy = vi.spyOn(FileSoulStore, "openReadOnly");
    const view = new ChainView({ chainDir: dir, doorPublicKeys: fixtureDoorPublicKeys() });

    const snaps = await Promise.all(Array.from({ length: 10 }, () => view.snapshot()));

    expect(openSpy).toHaveBeenCalledTimes(1);
    for (const snap of snaps) {
      expect(snap.unreadable).toBe(true);
    }
  });
});

describe("ChainView unreadable reuse window", () => {
  it("reuses an unreadable result until the TTL expires", async () => {
    const dir = await fixtureCopy("atlas-unreadable-ttl-");
    await breakMidBlob(dir);
    let now = 1_000;
    const openSpy = vi.spyOn(FileSoulStore, "openReadOnly");
    const view = new ChainView({
      chainDir: dir,
      doorPublicKeys: fixtureDoorPublicKeys(),
      unreadableTtlMs: 500,
      now: () => now
    });

    expect((await view.snapshot()).unreadable).toBe(true);
    expect((await view.snapshot()).unreadable).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);

    now += 499;
    await view.snapshot();
    expect(openSpy).toHaveBeenCalledTimes(1);

    now += 2;
    expect((await view.snapshot()).unreadable).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it("a blob restore invalidates the reuse window immediately", async () => {
    const dir = await fixtureCopy("atlas-unreadable-restore-");
    const { blobPath, blobBytes } = await breakMidBlob(dir);
    const view = new ChainView({
      chainDir: dir,
      doorPublicKeys: fixtureDoorPublicKeys(),
      unreadableTtlMs: 60_000
    });

    expect((await view.snapshot()).unreadable).toBe(true);
    await writeFile(blobPath, blobBytes);
    const recovered = await view.snapshot();
    expect(recovered.unreadable).toBeUndefined();
    expect(recovered.verified).toBe(true);
  });

  it("unreadableTtlMs 0 disables reuse", async () => {
    const dir = await fixtureCopy("atlas-unreadable-off-");
    await breakMidBlob(dir);
    const openSpy = vi.spyOn(FileSoulStore, "openReadOnly");
    const view = new ChainView({
      chainDir: dir,
      doorPublicKeys: fixtureDoorPublicKeys(),
      unreadableTtlMs: 0
    });

    await view.snapshot();
    await view.snapshot();
    expect(openSpy).toHaveBeenCalledTimes(2);
  });
});

describe("registerShutdownSignals", () => {
  function fakeProcess() {
    const listeners = new Map<string, (signal: NodeJS.Signals) => void>();
    const exits: number[] = [];
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const proc = {
      once(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) {
        listeners.set(event, listener);
        return proc;
      },
      exit(code?: number): never {
        exits.push(code ?? 0);
        resolveExit(code ?? 0);
        return undefined as never;
      }
    };
    return { proc, listeners, exits, exited };
  }

  it("closes the server and exits 0 on SIGTERM", async () => {
    const app = await createAtlasServer({
      chainDir: MULTI_RESIDENCY_FIXTURE_DIR,
      port: 0,
      doorPublicKeys: fixtureDoorPublicKeys()
    });
    const onClose = vi.fn();
    app.addHook("onClose", async () => {
      onClose();
    });
    const { proc, listeners, exits, exited } = fakeProcess();

    registerShutdownSignals(app, proc);
    expect([...listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

    listeners.get("SIGTERM")?.("SIGTERM");
    listeners.get("SIGINT")?.("SIGINT"); // second signal while closing is ignored
    await expect(exited).resolves.toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });

  it("exits 1 when close fails", async () => {
    const app = await createAtlasServer({
      chainDir: MULTI_RESIDENCY_FIXTURE_DIR,
      port: 0,
      doorPublicKeys: fixtureDoorPublicKeys()
    });
    vi.spyOn(app, "close").mockRejectedValue(new Error("boom"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { proc, listeners, exited } = fakeProcess();

    registerShutdownSignals(app, proc);
    listeners.get("SIGINT")?.("SIGINT");
    await expect(exited).resolves.toBe(1);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe("atlas-api process", () => {
  it("exits 0 promptly on SIGTERM instead of dying by signal", async () => {
    const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: packageDir,
      env: {
        ...process.env,
        ATLAS_CHAIN_DIR: MULTI_RESIDENCY_FIXTURE_DIR,
        ATLAS_PORT: String(port)
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/state`);
        if (response.ok) {
          break;
        }
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error("atlas-api did not start");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const signalledAt = Date.now();
    child.kill("SIGTERM");
    const result = await exited;
    expect(result).toEqual({ code: 0, signal: null });
    expect(Date.now() - signalledAt).toBeLessThan(5_000);
  }, 30_000);
});
