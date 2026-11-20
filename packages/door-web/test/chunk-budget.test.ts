import {
  decodePublicKey,
  encodePublicKey,
  generateKeypair,
  POP_VERSION,
  type Ed25519Keypair,
  type OspRecord
} from "@npc/osp-core";
import { ChainVerifier, type ChainStep, type VerifyChainOptions } from "@npc/osp-core/browser";
import { describe, expect, it } from "vitest";

import {
  CHAIN_VERIFY_CHUNK_MS,
  createVerifyWorker,
  feedVerifier,
  WORKER_REPLY_MS,
  type VerifyHooks,
  type VerifyWorker,
  type WorkerVerifyReply
} from "../src/browser/incremental-chain.js";
import { fetchChain } from "../src/browser/verify-porch.js";
import {
  appendRecord,
  DOOR_ID,
  RESIDENCY,
  serveHandledExport,
  type ChainCursor
} from "./shrine-fixture.js";

const ATTESTATIONS = 20_000;

describe("chunked verify stays on a time budget", () => {
  it("yields while verifying a 20k chain", async () => {
    const built = await buildChain(ATTESTATIONS - 1);
    const served = await serveHandledExport(() => ({
      status: 200,
      body: { records: built.records, doorPublicKeys: { [DOOR_ID]: built.doorKey }, blobs: {} }
    }));
    let time = 0;
    let suspended = false;
    let ranDuringSuspend = false;
    const marks: number[] = [0];
    const loaded = await fetchChain(
      {
        soulPublicKey: built.soulKey,
        doorId: DOOR_ID,
        doorPublicKey: built.doorKey,
        atlasUrl: served.url
      },
      null,
      function bareFetch(this: void, url: string, init?: RequestInit) {
        if (this !== undefined) {
          throw new TypeError("Illegal invocation");
        }
        return fetch(url, init);
      },
      {
        now(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return time;
        },
        yield(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          pushMark(marks, time);
          suspended = true;
          return Promise.resolve().then(() => {
            suspended = false;
          });
        },
        createVerifier: (options) => new ChargingVerifier(options, charge, peek, flag)
      } satisfies Partial<VerifyHooks>
    );
    await served.close();
    pushMark(marks, time);
    expect(loaded.hold.phase).toBe("verified");
    expect(loaded.client?.head?.seq).toBe(ATTESTATIONS);
    expect(loaded.client?.records).toHaveLength(ATTESTATIONS + 1);
    expect(ranDuringSuspend).toBe(false);
    expect(marks.length).toBeGreaterThan(2);
    assertBudget(marks);

    function charge(step: "parse" | "verify"): void {
      void step;
      time += 5;
    }

    function peek(): boolean {
      return suspended;
    }

    function flag(): void {
      ranDuringSuspend = true;
    }
  }, 180_000);

  it("parses a worker reply on the chunk clock and calls the worker", async () => {
    const built = await buildChain(12);
    const proven = await feedVerifier(
      new ChainVerifier({ doorPublicKeys: { [DOOR_ID]: built.doorBytes } }),
      built.records,
      null
    );
    expect(proven.ok).toBe(true);
    if (!proven.ok) {
      return;
    }
    let time = 0;
    let runs = 0;
    const marks: number[] = [0];
    const charging = chargingRecords(built.records, () => {
      time += 10;
    });
    const loaded = await fetchChain(
      {
        soulPublicKey: built.soulKey,
        doorId: DOOR_ID,
        doorPublicKey: built.doorKey,
        atlasUrl: "https://atlas.example"
      },
      null,
      function fetchExport(this: void, url: string) {
        if (this !== undefined) {
          throw new TypeError("Illegal invocation");
        }
        if (!url.endsWith("/chain/export")) {
          return Promise.reject(new Error(`unexpected fetch ${url}`));
        }
        return Promise.resolve(
          new ExportResponse({
            records: charging,
            doorPublicKeys: { [DOOR_ID]: built.doorKey },
            blobs: {}
          })
        );
      },
      workerHooks(
        marks,
        () => time,
        () => {
          runs += 1;
          return {
            id: 0,
            ok: true,
            fed: built.records.length,
            head: proven.head
          };
        }
      )
    );
    pushMark(marks, time);
    expect(runs).toBe(1);
    expect(loaded.hold.phase).toBe("verified");
    expect(loaded.client?.head).toEqual(proven.head);
    expect(marks.length).toBeGreaterThan(2);
    assertBudget(marks);
  });

  it("verifies in chunks when constructing the worker throws", async () => {
    const built = await buildChain(3);
    const served = await serveHandledExport(() => ({
      status: 200,
      body: { records: built.records, doorPublicKeys: { [DOOR_ID]: built.doorKey }, blobs: {} }
    }));
    let attempts = 0;
    const loaded = await fetchChain(
      {
        soulPublicKey: built.soulKey,
        doorId: DOOR_ID,
        doorPublicKey: built.doorKey,
        atlasUrl: served.url
      },
      null,
      function bareFetch(this: void, url: string, init?: RequestInit) {
        if (this !== undefined) {
          throw new TypeError("Illegal invocation");
        }
        return fetch(url, init);
      },
      {
        now(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return 0;
        },
        yield(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return Promise.resolve();
        },
        bundleSource: "onmessage = function () {};",
        createObjectURL(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return "blob:chunk-test";
        },
        revokeObjectURL(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
        },
        createWorker(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          attempts += 1;
          throw new Error("csp");
        }
      } satisfies Partial<VerifyHooks>
    );
    await served.close();
    expect(attempts).toBe(1);
    expect(loaded.hold.phase).toBe("verified");
    expect(loaded.client?.worker).toBeNull();
    expect(loaded.client?.head?.seq).toBe(built.records.length - 1);
  });

  it("verifies in chunks when the worker never replies", async () => {
    const built = await buildChain(1);
    const served = await serveHandledExport(() => ({
      status: 200,
      body: { records: built.records, doorPublicKeys: { [DOOR_ID]: built.doorKey }, blobs: {} }
    }));
    let terminated = 0;
    let armed: { ms: number; fire: () => void } | null = null;
    let posted: () => void = () => {
      throw new Error("worker posted before the test was listening");
    };
    const postedOnce = new Promise<void>((resolve) => {
      posted = resolve;
    });
    const pageWorker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onerror: null as (() => void) | null,
      postMessage(this: unknown) {
        if (this !== pageWorker) {
          throw new TypeError("Illegal invocation");
        }
        posted();
      },
      terminate(this: unknown) {
        if (this !== pageWorker) {
          throw new TypeError("Illegal invocation");
        }
        terminated += 1;
      }
    };
    function schedule(ms: number, fire: () => void): () => void {
      armed = { ms, fire };
      return () => {
        armed = null;
      };
    }
    const loaded = fetchChain(
      {
        soulPublicKey: built.soulKey,
        doorId: DOOR_ID,
        doorPublicKey: built.doorKey,
        atlasUrl: served.url
      },
      null,
      function bareFetch(this: void, url: string, init?: RequestInit) {
        if (this !== undefined) {
          throw new TypeError("Illegal invocation");
        }
        return fetch(url, init);
      },
      {
        now(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return 0;
        },
        yield(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return Promise.resolve();
        },
        bundleSource: "onmessage = function () {};",
        createObjectURL(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return "blob:timeout-test";
        },
        revokeObjectURL(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
        },
        createWorker(this: void) {
          if (this !== undefined) {
            throw new TypeError("Illegal invocation");
          }
          return createVerifyWorker(pageWorker, schedule);
        },
        schedule
      } satisfies Partial<VerifyHooks>
    );
    await postedOnce;
    if (armed === null) {
      throw new Error("worker did not arm a reply bound");
    }
    expect(armed.ms).toBe(WORKER_REPLY_MS);
    armed.fire();
    const result = await loaded;
    await served.close();
    expect(terminated).toBeGreaterThan(0);
    expect(result.hold.phase).toBe("verified");
    expect(result.client?.worker).toBeNull();
    expect(result.client?.head?.seq).toBe(built.records.length - 1);
  });
});

class ChargingVerifier extends ChainVerifier {
  constructor(
    options: VerifyChainOptions | undefined,
    private readonly charge: (step: "parse" | "verify") => void,
    private readonly suspended: () => boolean,
    private readonly flag: () => void
  ) {
    super(options);
  }

  override async evaluate(raw: unknown): Promise<ChainStep> {
    if (this.suspended()) {
      this.flag();
    }
    this.charge("parse");
    const step = await super.evaluate(raw);
    this.charge("verify");
    return step;
  }
}

class ExportResponse extends Response {
  constructor(private readonly payload: unknown) {
    super("{}", { status: 200, headers: { "content-type": "application/json" } });
  }

  override json(): Promise<unknown> {
    return Promise.resolve(this.payload);
  }
}

function workerHooks(
  marks: number[],
  readTime: () => number,
  reply: () => WorkerVerifyReply
): Partial<VerifyHooks> {
  const worker: VerifyWorker = {
    run(request) {
      if (this !== worker) {
        throw new TypeError("Illegal invocation");
      }
      const answered = reply();
      return Promise.resolve({ ...answered, id: request.id });
    },
    terminate() {
      if (this !== worker) {
        throw new TypeError("Illegal invocation");
      }
    }
  };
  return {
    now(this: void) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      return readTime();
    },
    yield(this: void) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      pushMark(marks, readTime());
      return Promise.resolve();
    },
    bundleSource: "onmessage = function () {};",
    createObjectURL(this: void) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      return "blob:worker-test";
    },
    revokeObjectURL(this: void) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
    },
    createWorker(this: void) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      return worker;
    },
    createVerifier: (options) => new ChainVerifier(options)
  };
}

function chargingRecords(records: readonly OspRecord[], charge: () => void): OspRecord[] {
  const list = [...records];
  return new Proxy(list, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        const iterator = target[Symbol.iterator]();
        return function values(this: void) {
          return {
            next(): IteratorResult<OspRecord> {
              charge();
              return iterator.next();
            }
          };
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    }
  });
}

function assertBudget(marks: number[]): void {
  for (let index = 1; index < marks.length; index += 1) {
    const previous = marks[index - 1];
    const current = marks[index];
    if (previous === undefined || current === undefined) {
      throw new Error("missing chunk mark");
    }
    const gap = current - previous;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(CHAIN_VERIFY_CHUNK_MS);
    expect(gap).toBeLessThanOrEqual(100);
  }
}

function pushMark(marks: number[], time: number): void {
  const previous = marks[marks.length - 1];
  if (previous !== time) {
    marks.push(time);
  }
}

function stamp(index: number): string {
  const hour = Math.floor(index / 3600);
  const minute = Math.floor((index % 3600) / 60);
  const second = index % 60;
  return `2026-01-02T${pad(hour)}:${pad(minute)}:${pad(second)}.000Z`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

async function buildChain(heartbeats: number): Promise<{
  records: OspRecord[];
  soulKey: string;
  doorKey: string;
  doorBytes: Uint8Array;
}> {
  const soul: Ed25519Keypair = generateKeypair();
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
  for (let index = 0; index < heartbeats; index += 1) {
    await appendRecord(chain, soul, door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: session,
        at: stamp(index + 1)
      },
      residency: RESIDENCY
    });
  }
  const doorKey = encodePublicKey(door.publicKey);
  return {
    records: chain.records,
    soulKey: encodePublicKey(soul.publicKey),
    doorKey,
    doorBytes: decodePublicKey(doorKey)
  };
}
