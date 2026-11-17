import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConcurrentAppendError } from "../src/errors.js";
import { FileLock, PROCESS_START_TOLERANCE_MS } from "../src/store/file-lock.js";

import { withLiveChildPid } from "./helpers/live-child.js";

/** This process's start time as FileLock records it (epoch ms). */
function ourStartedAt(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * Run a FileLock holder in a worker thread of THIS process (same PID, separate module
 * instance and nonce registry). Resolves once the worker holds the lock; the returned
 * function makes the worker release it and exit.
 */
async function holdLockInWorker(lockPath: string): Promise<() => Promise<void>> {
  const require = createRequire(import.meta.url);
  const workerData = {
    tsxApi: pathToFileURL(require.resolve("tsx/esm/api")).href,
    mod: new URL("../src/store/file-lock.ts", import.meta.url).href,
    lockPath
  };
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { register } = await import(workerData.tsxApi);
      register();
      const { FileLock } = await import(workerData.mod);
      const lock = new FileLock(workerData.lockPath);
      lock.acquire();
      parentPort.postMessage("held");
      parentPort.once("message", () => {
        lock.release();
        parentPort.postMessage("released");
      });
    })().catch((error) => parentPort.postMessage("error: " + (error && error.stack)));
  `;
  const worker = new Worker(code, { eval: true, workerData });
  const first = await new Promise<unknown>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  if (first !== "held") {
    await worker.terminate();
    throw new Error(`worker failed to acquire lock: ${String(first)}`);
  }
  return async () => {
    const released = new Promise<unknown>((resolve) => worker.once("message", resolve));
    worker.postMessage("release");
    expect(await released).toBe("released");
    await worker.terminate();
  };
}

describe("FileLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "osp-filelock-"));
    lockPath = path.join(dir, ".append.lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquires and releases the lock", () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    lock.release();
    lock.acquire();
    lock.release();
  });

  it("throws ConcurrentAppendError when another lock is held", async () => {
    const first = new FileLock(lockPath);
    first.acquire();

    const second = new FileLock(lockPath);
    expect(() => second.acquire()).toThrow(ConcurrentAppendError);
    expect(() => second.acquire()).toThrow(
      "another append is in progress (or a stale .append.lock remains after a crash — use openWithRecovery)"
    );

    first.release();
    second.acquire();
    second.release();
  });

  it("release() by a non-holder leaves a live lock intact", () => {
    const holder = new FileLock(lockPath);
    holder.acquire();
    new FileLock(lockPath).release();
    expect(existsSync(lockPath)).toBe(true);
    holder.release();
  });

  it("clearStale refuses a live fresh lock held by another process", async () => {
    await withLiveChildPid(async (pid) => {
      const meta = JSON.stringify({
        pid,
        acquiredAt: new Date().toISOString(),
        nonce: "0123456789abcdef"
      });
      await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

      const lock = new FileLock(lockPath);
      await expect(lock.clearStale()).rejects.toThrow(ConcurrentAppendError);
      await expect(lock.clearStale()).rejects.toThrow(/live \.append\.lock/);
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  it("clearStale refuses a legacy (nonce-less) fresh lock held by another live process", async () => {
    await withLiveChildPid(async (pid) => {
      const meta = JSON.stringify({ pid, acquiredAt: new Date().toISOString() });
      await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

      await expect(new FileLock(lockPath).clearStale()).rejects.toThrow(ConcurrentAppendError);
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  it("clearStale refuses a lock held by another FileLock in this process", async () => {
    const holder = new FileLock(lockPath);
    holder.acquire();
    try {
      await expect(new FileLock(lockPath).clearStale()).rejects.toThrow(/live \.append\.lock/);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      holder.release();
    }
  });

  it("writes pid, acquiredAt and a per-acquisition nonce", async () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    try {
      const meta: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      expect(meta).toMatchObject({ pid: process.pid });
      expect(typeof Reflect.get(meta as object, "acquiredAt")).toBe("string");
      expect(Reflect.get(meta as object, "nonce")).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      lock.release();
    }
  });

  it("clearStale removes a fresh lock carrying OUR pid but a nonce we do not hold (PID-1 restart)", async () => {
    // Previous container incarnation (also PID 1) was SIGKILLed mid-append. Legacy (v0.4.3)
    // metadata without a process identity: v0.4.3 ran one store-opening process per
    // container, so a same-PID legacy lock can only be a previous incarnation's.
    const meta = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: "feedfacefeedfacefeedfacefeedface"
    });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    const lock = new FileLock(lockPath);
    await lock.clearStale();
    expect(existsSync(lockPath)).toBe(false);
    lock.acquire();
    lock.release();
  });

  it("clearStale removes a fresh legacy lock carrying OUR pid and no nonce", async () => {
    const meta = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    await new FileLock(lockPath).clearStale();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("treats a legacy PID-1 lock as stale when this process is not PID 1 (compose init)", async () => {
    // v0.4.3 ran node as container PID 1; under `init: true` PID 1 is tini, which is alive
    // but never holds a store lock.
    const meta = JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    await new FileLock(lockPath, { isProcessAlive: () => true }).clearStale();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("uses an injected liveness probe for other PIDs", async () => {
    const meta = JSON.stringify({
      pid: 424_242,
      acquiredAt: new Date().toISOString(),
      nonce: "00"
    });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    await expect(
      new FileLock(lockPath, { isProcessAlive: () => true }).clearStale()
    ).rejects.toThrow(ConcurrentAppendError);
    await new FileLock(lockPath, { isProcessAlive: () => false }).clearStale();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("clearStale steals a live holder's lock once it exceeds maxAgeMs", async () => {
    await withLiveChildPid(async (pid) => {
      const meta = JSON.stringify({ pid, acquiredAt: new Date(0).toISOString(), nonce: "aa" });
      await writeFile(lockPath, `${meta}\n`, { flag: "wx" });
      await new FileLock(lockPath).clearStale();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  it("clearStale removes a dead-PID or legacy empty lock", async () => {
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date().toISOString() })}\n`,
      { flag: "wx" }
    );

    const lock = new FileLock(lockPath);
    await lock.clearStale();

    lock.acquire();
    lock.release();

    await writeFile(lockPath, "", { flag: "wx" });
    await lock.clearStale();
    lock.acquire();
    lock.release();
  });

  it("writes the process identity (host + start time) into the lock", async () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    try {
      const meta: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      expect(meta).toMatchObject({ pid: process.pid, host: hostname() });
      const startedAt = Reflect.get(meta as object, "startedAt");
      expect(typeof startedAt).toBe("number");
      expect(Math.abs((startedAt as number) - ourStartedAt())).toBeLessThanOrEqual(
        PROCESS_START_TOLERANCE_MS
      );
    } finally {
      lock.release();
    }
  });

  it("clearStale refuses a lock held by a worker thread of this process (same PID, unknown nonce)", async () => {
    const release = await holdLockInWorker(lockPath);
    try {
      await expect(new FileLock(lockPath).clearStale()).rejects.toThrow(/live \.append\.lock/);
      expect(existsSync(lockPath)).toBe(true);
      expect(() => new FileLock(lockPath).acquire()).toThrow(ConcurrentAppendError);
    } finally {
      await release();
    }
    expect(existsSync(lockPath)).toBe(false);
    const lock = new FileLock(lockPath);
    lock.acquire();
    lock.release();
  }, 30_000);

  it("clearStale refuses a lock held by a second module instance in this process", async () => {
    vi.resetModules();
    const second = (await import("../src/store/file-lock.js")) as {
      FileLock: typeof FileLock;
    };
    expect(second.FileLock).not.toBe(FileLock);
    const holder = new second.FileLock(lockPath);
    holder.acquire();
    try {
      await expect(new FileLock(lockPath).clearStale()).rejects.toThrow(/live \.append\.lock/);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      holder.release();
    }
  });

  it("clearStale removes a same-host, same-PID lock from a previous incarnation (start time differs)", async () => {
    // Container restart: node is the same PID again, but the process started later.
    const meta = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: "feedfacefeedfacefeedfacefeedface",
      host: hostname(),
      startedAt: ourStartedAt() - 60_000
    });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    await new FileLock(lockPath).clearStale();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("clearStale treats a same-host, same-PID, same-start-time lock as live within tolerance", async () => {
    const meta = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: "feedfacefeedfacefeedfacefeedface",
      host: hostname(),
      startedAt: ourStartedAt() + Math.floor(PROCESS_START_TOLERANCE_MS / 2)
    });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    await expect(new FileLock(lockPath).clearStale()).rejects.toThrow(ConcurrentAppendError);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("clearStale treats a fresh lock from another host as live (unprobeable) until maxAgeMs", async () => {
    const otherHost = `${hostname()}-other`;
    for (const pid of [process.pid, 2_147_483_647]) {
      const meta = JSON.stringify({
        pid,
        acquiredAt: new Date().toISOString(),
        nonce: "ab",
        host: otherHost,
        startedAt: 0
      });
      await writeFile(lockPath, `${meta}\n`);
      await expect(
        new FileLock(lockPath, { isProcessAlive: () => false }).clearStale()
      ).rejects.toThrow(new RegExp(`host ${otherHost}`));
      expect(existsSync(lockPath)).toBe(true);
    }

    const old = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(0).toISOString(),
      nonce: "ab",
      host: otherHost,
      startedAt: 0
    });
    await writeFile(lockPath, `${old}\n`);
    await new FileLock(lockPath).clearStale();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("probes other PIDs on the same host", async () => {
    const meta = JSON.stringify({
      pid: 424_242,
      acquiredAt: new Date().toISOString(),
      nonce: "00",
      host: hostname(),
      startedAt: ourStartedAt()
    });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    await expect(
      new FileLock(lockPath, { isProcessAlive: () => true }).clearStale()
    ).rejects.toThrow(ConcurrentAppendError);
    await new FileLock(lockPath, { isProcessAlive: () => false }).clearStale();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("treats a lock with a partial identity as legacy (same PID → stale)", async () => {
    const meta = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      nonce: "ab",
      host: hostname()
    });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    await new FileLock(lockPath).clearStale();
    expect(existsSync(lockPath)).toBe(false);
  });
});
