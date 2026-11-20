import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import {
  decodeBase64Url,
  decodePublicKey,
  encodeBase64Url,
  encodePublicKey,
  generateKeypair,
  POP_VERSION,
  type OspRecord
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { SHRINE_REFRESH_MS } from "../src/browser/shrine.js";
import { buildPorchBundle, buildShrineBundle } from "../scripts/bundle-browser.mjs";
import { appendRecord, DOOR_ID, RESIDENCY, type ChainCursor } from "./shrine-fixture.js";

describe("porch verify.js bundle", () => {
  it("matches the committed file and does not reach Node or eval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-bundle-"));
    try {
      const outfile = join(dir, "verify.js");
      const built = await buildPorchBundle(outfile);
      const fresh = await readFile(outfile);
      const committed = await readFile(new URL("../public/verify.js", import.meta.url));
      expect(Buffer.compare(fresh, committed)).toBe(0);
      const text = fresh.toString("utf8");
      expect(built.bytes).toBeGreaterThan(1000);
      expect(built.bytes).toBeLessThan(600_000);
      expect(built.inputs.some((path: string) => path.includes("sha2-browser.js"))).toBe(true);
      expect(built.inputs.some((path: string) => path.includes("node:"))).toBe(false);
      expect(text).not.toContain("node:fs");
      expect(text).not.toContain("node:crypto");
      expect(text).not.toContain("eval(");
      expect(text).toContain("createObjectURL");
      expect(text).toContain("Worker");
      expect(zodParsesWithoutFunction(text)).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches the committed shrine.js and does not reach Node or eval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shrine-bundle-"));
    try {
      const outfile = join(dir, "shrine.js");
      const built = await buildShrineBundle(outfile);
      const fresh = await readFile(outfile);
      const committed = await readFile(new URL("../public/shrine.js", import.meta.url));
      expect(Buffer.compare(fresh, committed)).toBe(0);
      const text = fresh.toString("utf8");
      expect(built.bytes).toBeGreaterThan(1000);
      expect(built.bytes).toBeLessThan(600_000);
      expect(built.inputs.some((path: string) => path.includes("sha2-browser.js"))).toBe(true);
      expect(built.inputs.some((path: string) => path.includes("node:"))).toBe(false);
      expect(text).not.toContain("node:fs");
      expect(text).not.toContain("eval(");
      expect(text).toContain("createObjectURL");
      expect(text).toContain("Worker");
      expect(await shrineParsesWithoutFunction(text)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refetches the built shrine.js when timers and fetch keep the page as this", async () => {
    const source = await readFile(new URL("../public/shrine.js", import.meta.url), "utf8");
    const run = await runShrineAgainstPageReceivers(source);
    const listenerAt = run.order.indexOf("visibilitychange");
    const intervalAt = run.order.indexOf("setInterval");
    expect(listenerAt).toBeGreaterThanOrEqual(0);
    expect(intervalAt).toBeGreaterThan(listenerAt);
    expect(run.fetches).toEqual(["https://atlas.example/chain/export"]);
    expect(run.intervalMs).toBe(SHRINE_REFRESH_MS);
    run.fireInterval();
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(run.fetches).toEqual(["https://atlas.example/chain/export"]);
    run.show();
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(run.fetches).toEqual([
      "https://atlas.example/chain/export",
      "https://atlas.example/chain/export"
    ]);
  });

  it("answers a reset and a forged signature from the built worker bundles", async () => {
    const chain = await workerChain();
    const forged = chain.records.slice();
    const last = forged[forged.length - 1];
    if (last === undefined) {
      throw new Error("missing heartbeat");
    }
    forged[forged.length - 1] = forgeSignature(last);
    for (const fileName of ["verify.js", "shrine.js"]) {
      const source = await readFile(new URL(`../public/${fileName}`, import.meta.url), "utf8");
      const session = loadWorkerBundle(source);
      const admitted = await session.post({
        id: 1,
        reset: true,
        records: chain.records,
        doorPublicKeys: chain.keys
      });
      expect(admitted).toEqual({ id: 1, ok: true, fed: 3, head: { seq: 2 } });
      const rejected = await session.post({
        id: 2,
        reset: true,
        records: forged,
        doorPublicKeys: chain.keys
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.id).toBe(2);
      expect(session.illegal).toBe(0);
    }
  }, 20_000);
});

/**
 * Load the bundle with `Function` throwing. Zod's JIT probe calls `new Function`
 * unless `jitless` was set before the schemas were built, so dropping that import fails here.
 */
function zodParsesWithoutFunction(source: string): string {
  let invoked = 0;
  function throwingFunction(): never {
    invoked += 1;
    throw new Error("Function invoked");
  }
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    fetch: (): Promise<Response> => Promise.reject(new Error("no network")),
    AbortSignal,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    performance,
    atob: (value: string): string => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string): string => Buffer.from(value, "binary").toString("base64"),
    Function: throwingFunction
  };
  const context = createContext(sandbox);
  runInContext(source, context, { timeout: 5_000 });
  const verdict: unknown = runInContext(
    'globalThis.WandererVerify.verifyText({ phase: "verified", open: null }, { from: "wanderer", text: "hi", proof: { nope: true } })',
    context,
    { timeout: 5_000 }
  );
  if (invoked !== 0) {
    throw new Error("zod called Function");
  }
  if (typeof verdict !== "string") {
    throw new Error("verifyText did not return a verdict");
  }
  return verdict;
}

/**
 * Load the shrine bundle where `Function` throws, then make it parse a record.
 * Schema init or `verifyRecords` calls `new Function` unless `jitless` ran first.
 */
async function shrineParsesWithoutFunction(source: string): Promise<number> {
  let invoked = 0;
  function throwingFunction(): never {
    invoked += 1;
    throw new Error("Function invoked");
  }
  let parsed = false;
  const response = {
    ok: true,
    status: 200,
    headers: { get: (): string | null => null },
    json: (): Promise<unknown> => {
      parsed = true;
      return Promise.resolve({ records: [{}], doorPublicKeys: {}, blobs: {} });
    }
  };
  const element = (): {
    textContent: string;
    children: unknown[];
    setAttribute(): void;
    appendChild(child: unknown): void;
    attachShadow(): ReturnType<typeof element>;
  } => {
    const node = {
      textContent: "",
      children: [] as unknown[],
      setAttribute(): void {
        return;
      },
      appendChild(child: unknown): void {
        node.children.push(child);
      },
      attachShadow(): ReturnType<typeof element> {
        return node;
      }
    };
    return node;
  };
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    fetch: (): Promise<typeof response> => Promise.resolve(response),
    AbortSignal,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    performance,
    atob: (value: string): string => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string): string => Buffer.from(value, "binary").toString("base64"),
    Function: throwingFunction,
    document: {
      visibilityState: "visible",
      currentScript: {
        dataset: { atlasUrl: "http://127.0.0.1:9", mount: "#wanderer-shrine" }
      },
      querySelector: (): ReturnType<typeof element> => element(),
      createElement: (): ReturnType<typeof element> => element(),
      addEventListener(): void {
        return;
      }
    },
    setInterval: (): number => 1,
    clearInterval: (): void => undefined
  };
  const context = createContext(sandbox);
  runInContext(source, context, { timeout: 5_000 });
  const deadline = Date.now() + 1_000;
  while (!parsed && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  if (!parsed) {
    throw new Error("shrine bundle did not read an export");
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  if (invoked !== 0) {
    throw new Error("zod called Function");
  }
  return invoked;
}

type ShrineReceiverRun = {
  order: string[];
  fetches: string[];
  intervalMs: number;
  fireInterval: () => void;
  show: () => void;
};

/**
 * Load `public/shrine.js` in a vm whose `setInterval`, `fetch`, and document
 * methods throw unless `this` is the page. Node's vm global is not the sandbox
 * object, so the window is captured from inside the context first.
 */
function runShrineAgainstPageReceivers(source: string): ShrineReceiverRun {
  const order: string[] = [];
  const fetches: string[] = [];
  let visibilityState = "hidden";
  let onVisible: (() => void) | null = null;
  let onInterval: (() => void) | null = null;
  let intervalMs = 0;
  let fakeDocument: ShrineVmDocument | null = null;
  let fakeWindow: object | null = null;
  const host = shrineElement();

  const document: ShrineVmDocument = {
    currentScript: {
      dataset: { atlasUrl: "https://atlas.example", mount: "#wanderer-shrine" }
    },
    get visibilityState(): string {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      return visibilityState;
    },
    set visibilityState(value: string) {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      visibilityState = value;
    },
    querySelector(selector: string): ReturnType<typeof shrineElement> | null {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      return selector === "#wanderer-shrine" ? host : null;
    },
    createElement(): ReturnType<typeof shrineElement> {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      return shrineElement();
    },
    addEventListener(type: string, listener: () => void): void {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      if (type !== "visibilitychange") {
        return;
      }
      order.push("visibilitychange");
      onVisible = listener;
    }
  };
  fakeDocument = document;

  function setInterval(this: unknown, fn: () => void, ms: number): number {
    if (this !== fakeWindow) {
      throw new TypeError("Illegal invocation");
    }
    order.push("setInterval");
    intervalMs = ms;
    onInterval = fn;
    return 1;
  }

  function fetchImpl(
    this: unknown,
    input: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1]
  ): Promise<Response> {
    if (this !== fakeWindow) {
      throw new TypeError("Illegal invocation");
    }
    order.push("fetch");
    fetches.push(String(input));
    return Promise.resolve(new Response(null, { status: 500 }));
  }

  function clearInterval(this: unknown, _id: number): void {
    if (this !== fakeWindow) {
      throw new TypeError("Illegal invocation");
    }
  }

  let invoked = 0;
  function throwingFunction(): never {
    invoked += 1;
    throw new Error("Function invoked");
  }

  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    AbortSignal,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    performance,
    atob: (value: string): string => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string): string => Buffer.from(value, "binary").toString("base64"),
    Function: throwingFunction,
    document
  };
  const context = createContext(sandbox);
  const capture = (win: object): void => {
    fakeWindow = win;
  };
  Object.assign(sandbox, { __capture: capture });
  runInContext("globalThis.__capture(globalThis); delete globalThis.__capture;", context);
  if (fakeWindow === null) {
    throw new Error("vm global was not captured");
  }
  Object.assign(sandbox, { setInterval, fetch: fetchImpl, clearInterval });

  const stolenInterval = setInterval;
  const stolenFetch = fetchImpl;
  const stolenQuery = document.querySelector;
  expect(() => {
    stolenInterval(() => undefined, 1);
  }).toThrow(TypeError);
  expect(() => {
    void stolenFetch("https://atlas.example/chain/export");
  }).toThrow(TypeError);
  expect(() => {
    stolenQuery("#wanderer-shrine");
  }).toThrow(TypeError);

  runInContext(source, context, { timeout: 5_000 });
  if (invoked !== 0) {
    throw new Error("zod called Function");
  }
  return {
    order,
    fetches,
    get intervalMs(): number {
      return intervalMs;
    },
    fireInterval(): void {
      if (onInterval === null) {
        throw new Error("interval was not scheduled");
      }
      onInterval();
    },
    show(): void {
      document.visibilityState = "visible";
      if (onVisible === null) {
        throw new Error("visibilitychange listener was not registered");
      }
      onVisible();
    }
  };
}

type ShrineVmDocument = {
  visibilityState: string;
  currentScript: { dataset: { atlasUrl: string; mount: string } };
  querySelector(selector: string): ReturnType<typeof shrineElement> | null;
  createElement(tag: string): ReturnType<typeof shrineElement>;
  addEventListener(type: string, listener: () => void): void;
};

function shrineElement(): {
  textContent: string;
  setAttribute(): void;
  appendChild(): void;
  attachShadow(): ReturnType<typeof shrineElement>;
} {
  const node = {
    textContent: "",
    setAttribute(): void {
      return;
    },
    appendChild(): void {
      return;
    },
    attachShadow(): ReturnType<typeof shrineElement> {
      return shrineElement();
    }
  };
  return node;
}

type WorkerReply = {
  id: number;
  ok: boolean;
  fed: number;
  head: { seq: number } | null;
};

type WorkerJob = {
  id: number;
  reset: boolean;
  records: readonly OspRecord[];
  doorPublicKeys: Record<string, number[]>;
};

type WorkerSession = {
  illegal: number;
  post(job: WorkerJob): Promise<WorkerReply>;
};

/**
 * Evaluate a built classic bundle as a dedicated worker.
 * `postMessage` throws when `this` is not the worker global.
 */
function loadWorkerBundle(source: string): WorkerSession {
  let illegal = 0;
  let resolveReply: ((reply: WorkerReply) => void) | null = null;
  const mark = {};
  // A vm global is a proxy of this object, so `this === sandbox` is false even
  // for a correct `globalThis.postMessage(...)`. The mark is the receiver.
  const isWorker = (receiver: unknown): boolean =>
    typeof receiver === "object" &&
    receiver !== null &&
    "mark" in receiver &&
    receiver.mark === mark;
  const sandbox = {
    mark,
    console,
    unescape,
    escape,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    AbortSignal,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    performance,
    atob: (value: string): string => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string): string => Buffer.from(value, "binary").toString("base64"),
    importScripts(this: unknown): void {
      if (!isWorker(this)) {
        illegal += 1;
        throw new TypeError("Illegal invocation");
      }
    },
    postMessage(this: unknown, message: unknown): void {
      if (!isWorker(this)) {
        illegal += 1;
        throw new TypeError("Illegal invocation");
      }
      const done = resolveReply;
      resolveReply = null;
      if (done === null) {
        throw new Error("worker replied with nobody waiting");
      }
      done(readWorkerReply(message));
    },
    onmessage: null as ((event: { data: unknown }) => void) | null,
    job: null as WorkerJob | null
  };
  const context = createContext(sandbox);
  runInContext(WORKER_TEXT_CODECS, context, { timeout: 5_000 });
  runInContext(source, context, { timeout: 5_000 });
  return {
    get illegal() {
      return illegal;
    },
    post(job) {
      const pending = new Promise<WorkerReply>((resolve) => {
        resolveReply = resolve;
      });
      sandbox.job = job;
      runInContext(DELIVER_JOB, context, { timeout: 5_000 });
      return pending;
    }
  };
}

const WORKER_TEXT_CODECS = `
globalThis.TextEncoder = class TextEncoder {
  encode(text) {
    const binary = unescape(encodeURIComponent(String(text)));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
};
globalThis.TextDecoder = class TextDecoder {
  decode(bytes) {
    const chars = [];
    for (const byte of bytes) {
      chars.push(String.fromCharCode(byte));
    }
    return decodeURIComponent(escape(chars.join("")));
  }
};
`;

const DELIVER_JOB = `(() => {
  const raw = globalThis.job;
  const doorPublicKeys = {};
  for (const doorId of Object.keys(raw.doorPublicKeys)) {
    doorPublicKeys[doorId] = new Uint8Array(raw.doorPublicKeys[doorId]);
  }
  const handler = globalThis.onmessage;
  if (typeof handler !== "function") {
    throw new Error("worker did not install onmessage");
  }
  handler({
    data: {
      id: raw.id,
      reset: raw.reset,
      records: JSON.parse(JSON.stringify(raw.records)),
      doorPublicKeys
    }
  });
})()`;

function readWorkerReply(message: unknown): WorkerReply {
  if (typeof message !== "object" || message === null) {
    throw new Error("worker reply was not an object");
  }
  if (!("id" in message) || !("ok" in message) || !("fed" in message) || !("head" in message)) {
    throw new Error("worker reply was missing fields");
  }
  const { id, ok, fed, head } = message;
  if (typeof id !== "number" || typeof ok !== "boolean" || typeof fed !== "number") {
    throw new Error("worker reply had the wrong types");
  }
  if (head === null) {
    return { id, ok, fed, head: null };
  }
  if (typeof head !== "object" || !("seq" in head) || typeof head.seq !== "number") {
    throw new Error("worker reply head was not a cursor");
  }
  return { id, ok, fed, head: { seq: head.seq } };
}

function forgeSignature(record: OspRecord): OspRecord {
  const bytes = Uint8Array.from(decodeBase64Url(record.sig));
  const index = Math.floor(bytes.length / 2);
  const current = bytes[index];
  if (current === undefined) {
    throw new Error("empty signature");
  }
  bytes[index] = current ^ 0xff;
  return { ...record, sig: encodeBase64Url(bytes) };
}

async function workerChain(): Promise<{
  records: OspRecord[];
  keys: Record<string, number[]>;
}> {
  const soul = generateKeypair();
  const door = generateKeypair();
  const session = encodePublicKey(generateKeypair().publicKey);
  const chain: ChainCursor = { records: [], prev: null, seq: 0 };
  await appendRecord(chain, soul, null, {
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nI travel.",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null
  });
  await appendRecord(chain, soul, door, {
    type: "attestation",
    body: {
      kind: "arrival",
      pop_version: POP_VERSION,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: session,
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY
  });
  await appendRecord(chain, soul, door, {
    type: "attestation",
    body: {
      kind: "heartbeat",
      pop_version: POP_VERSION,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: session,
      at: "2026-01-02T00:00:01.000Z"
    },
    residency: RESIDENCY
  });
  return {
    records: chain.records,
    keys: { [DOOR_ID]: [...decodePublicKey(encodePublicKey(door.publicKey))] }
  };
}
