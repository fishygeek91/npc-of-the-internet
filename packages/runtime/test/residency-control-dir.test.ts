import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_NOT_ACCEPTED, EXIT_USAGE, runWandererCli } from "../src/cli.js";
import {
  consumeDepartRequest,
  isDepartRequestPending,
  requestDaemonDepart,
  watchControlDir,
  writeDepartRequest
} from "../src/residency/control-dir.js";
import { FakeTimer } from "./helpers/fake-timer.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "npc-control-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("control dir depart requests", () => {
  it("a request is consumed exactly once", async () => {
    const dir = await tempDir();
    expect(await consumeDepartRequest(dir)).toBe(false);
    await writeDepartRequest(dir, "2026-10-05T00:00:00.000Z");
    expect(await isDepartRequestPending(dir)).toBe(true);
    expect(await consumeDepartRequest(dir)).toBe(true);
    expect(await consumeDepartRequest(dir)).toBe(false);
    // Atomic write leaves no temp files behind.
    expect(await readdir(dir)).toEqual([]);
  });

  it("the daemon watcher creates the dir (0700), fires once per request, and stops", async () => {
    const parent = await tempDir();
    const dir = join(parent, "ctl");
    const timer = new FakeTimer();
    let fired = 0;
    const watcher = await watchControlDir({
      controlDir: dir,
      timer,
      onDepartRequest: () => {
        fired += 1;
      }
    });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    timer.tick();
    await settle();
    expect(fired).toBe(0);

    await writeDepartRequest(dir, "2026-10-05T00:00:00.000Z");
    timer.tick();
    await settle();
    timer.tick();
    await settle();
    expect(fired).toBe(1);

    watcher.stop();
    await writeDepartRequest(dir, "2026-10-05T00:00:01.000Z");
    timer.tick();
    await settle();
    expect(fired).toBe(1);
  });

  it("requestDaemonDepart withdraws an unclaimed request on timeout", async () => {
    const dir = await tempDir();
    const accepted = await requestDaemonDepart({
      controlDir: dir,
      timeoutMs: 30,
      pollMs: 10
    });
    expect(accepted).toBe(false);
    expect(await isDepartRequestPending(dir)).toBe(false);
  });

  it("requestDaemonDepart resolves true once a watcher picks the request up", async () => {
    const dir = await tempDir();
    const pending = requestDaemonDepart({ controlDir: dir, timeoutMs: 5_000, pollMs: 10 });
    while (!(await isDepartRequestPending(dir))) {
      await settle();
    }
    expect(await consumeDepartRequest(dir)).toBe(true);
    expect(await pending).toBe(true);
  });
});

describe("wanderer depart", () => {
  it("uses NPC_CONTROL_DIR and reports acceptance", async () => {
    const out: string[] = [];
    let seen: { controlDir: string; timeoutMs: number } | undefined;
    const code = await runWandererCli(["node", "wanderer", "depart"], {
      env: { NPC_CONTROL_DIR: "/tmp/ctl-from-env" },
      runDepart: async (options) => {
        seen = options;
        return true;
      },
      writeStdout: (line) => out.push(line),
      writeStderr: () => undefined
    });
    expect(code).toBe(0);
    expect(seen).toEqual({ controlDir: "/tmp/ctl-from-env", timeoutMs: 15_000 });
    expect(out.join("\n")).toMatch(/accepted/);
  });

  it("exits 1 when no daemon picks the request up", async () => {
    const dir = await tempDir();
    const err: string[] = [];
    const code = await runWandererCli(
      ["node", "wanderer", "depart", "--control-dir", dir, "--timeout-ms", "30"],
      { writeStdout: () => undefined, writeStderr: (line) => err.push(line) }
    );
    expect(code).toBe(EXIT_NOT_ACCEPTED);
    expect(err.join("\n")).toMatch(/NPC_RESIDENCY_OPERATOR_TRIGGER/);
    expect(await isDepartRequestPending(dir)).toBe(false);
  });

  it("rejects a bad --timeout-ms", async () => {
    const code = await runWandererCli(["node", "wanderer", "depart", "--timeout-ms", "soon"], {
      runDepart: async () => true,
      writeStdout: () => undefined,
      writeStderr: () => undefined
    });
    expect(code).toBe(EXIT_USAGE);
  });
});
