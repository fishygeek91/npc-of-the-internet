import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConcurrentAppendError } from "../src/errors.js";
import { FileLock } from "../src/store/file-lock.js";

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

  it("clearStale refuses a live fresh lock", async () => {
    const meta = JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    });
    await writeFile(lockPath, `${meta}\n`, { flag: "wx" });

    const lock = new FileLock(lockPath);
    await expect(lock.clearStale()).rejects.toThrow(ConcurrentAppendError);
    await expect(lock.clearStale()).rejects.toThrow(/live \.append\.lock/);
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
