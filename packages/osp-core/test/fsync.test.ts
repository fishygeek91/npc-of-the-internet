import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { bytesEqual, writeAllSync } from "../src/store/fsync.js";

describe("bytesEqual", () => {
  it("returns true for identical byte arrays", () => {
    const left = new Uint8Array([1, 2, 3]);
    const right = new Uint8Array([1, 2, 3]);
    expect(bytesEqual(left, right)).toBe(true);
  });

  it("returns false for different lengths or bytes", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
});

describe("writeAllSync", () => {
  it("writes the full buffer even when writeSync returns short counts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "osp-fsync-"));
    const filePath = path.join(dir, "out.bin");
    const data = new Uint8Array(64_000);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = index % 256;
    }

    const fd = openSync(filePath, "w");
    try {
      writeAllSync(fd, data);
    } finally {
      closeSync(fd);
    }

    const readBack = new Uint8Array(readFileSync(filePath));
    expect(bytesEqual(readBack, data)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
