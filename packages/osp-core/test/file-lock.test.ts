import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConcurrentAppendError } from "../src/errors.js";
import { FileLock } from "../src/store/file-lock.js";

import { withLiveChildPid } from "./helpers/live-child.js";

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
    // Previous container incarnation (also PID 1) was SIGKILLed mid-append.
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
});
