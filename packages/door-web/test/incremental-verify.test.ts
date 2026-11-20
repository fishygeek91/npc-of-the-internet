import {
  createRecord,
  decodeBase64Url,
  encodeBase64Url,
  encodePublicKey,
  generateKeypair,
  OSP_SPEC_V02,
  POP_VERSION,
  type Ed25519Keypair,
  type OspRecord
} from "@npc/osp-core";
import { ChainVerifier, type ChainStep, type VerifyChainOptions } from "@npc/osp-core/browser";
import { afterEach, describe, expect, it } from "vitest";

import { type VerifyHooks } from "../src/browser/incremental-chain.js";
import { JOURNAL_ERASED, loadShrine } from "../src/browser/shrine-chain.js";
import { fetchChain, verifyReaction, verifyText } from "../src/browser/verify-porch.js";
import { signedOutbound } from "./helpers.js";
import {
  appendRecord,
  bareFetch,
  DOOR_ID,
  pins as shrinePins,
  PROSE,
  RESIDENCY,
  serveHandledExport,
  stay,
  type ChainCursor
} from "./shrine-fixture.js";

/**
 * Receiver check for browser globals. A method call sets `this` and must fail the test
 * even when production code catches the throw.
 */
let illegalReceivers = 0;

function rejectReceiver(receiver: unknown): void {
  if (receiver !== undefined) {
    illegalReceivers += 1;
    throw new TypeError("Illegal invocation");
  }
}

describe("incremental porch and shrine verify", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    illegalReceivers = 0;
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  it("feeds one heartbeat on refetch and matches a full verify", async () => {
    const built = await buildStay();
    const mode: { tail: "empty" | "beat" } = { tail: "beat" };
    const served = await serve(closers, (path) => exportReply(path, built, mode));
    let fed = 0;
    const hooks = countingHooks(() => {
      fed += 1;
    });
    const first = await fetchChain(porchPins(built, served.url), null, bareFetch, hooks);
    expect(first.hold.phase).toBe("verified");
    expect(fed).toBe(built.prefix.length);
    fed = 0;
    const again = await fetchChain(porchPins(built, served.url), first, bareFetch, hooks);
    expect(fed).toBe(1);
    expect(again.hold.phase).toBe("verified");
    const whole = await serve(closers, () => ({
      status: 200,
      body: chainBody(built.full, built.keys)
    }));
    const fresh = await fetchChain(porchPins(built, whole.url), null, bareFetch, staticHooks());
    expect(again.hold).toEqual(fresh.hold);
    expect(illegalReceivers).toBe(0);

    fed = 0;
    const shrineFirst = await loadShrine(
      shrinePins(served.url, built.soul),
      null,
      bareFetch,
      hooks
    );
    expect(shrineFirst.snapshot.badge).toBe("PRESENT");
    fed = 0;
    const shrineAgain = await loadShrine(
      shrinePins(served.url, built.soul),
      shrineFirst,
      bareFetch,
      hooks
    );
    expect(fed).toBe(1);
    expect(shrineAgain.snapshot.badge).toBe("PRESENT");
    expect(illegalReceivers).toBe(0);
  });

  it("drops a tombstoned journal named by the tail", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const built = await stay(soul, door);
    const keys = doorKeys(door);
    const tombstone = await createRecord({
      spec: OSP_SPEC_V02,
      seq: built.records.length,
      prev: built.headCid,
      type: "tombstone",
      body: {
        target_cid: built.headCid,
        blob_cid: built.journalCid,
        reason: "erasure_request",
        erased_at: "2026-01-03T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      soulPrivateKey: soul.privateKey
    });
    let tail = false;
    const served = await serve(closers, (path) => {
      if (path.includes("after=") && tail) {
        return { status: 200, body: chainBody([tombstone.record], keys) };
      }
      return {
        status: 200,
        body: { records: built.records, doorPublicKeys: keys, blobs: built.blobs }
      };
    });
    const first = await loadShrine(shrinePins(served.url, soul), null, bareFetch, staticHooks());
    expect(first.snapshot.journals).toEqual([PROSE]);
    tail = true;
    const again = await loadShrine(shrinePins(served.url, soul), first, bareFetch, staticHooks());
    expect(again.snapshot.journals).toEqual([JOURNAL_ERASED]);
    expect(again.client?.blobs[built.journalCid]).toBeUndefined();
    expect(illegalReceivers).toBe(0);
  });

  it("resets once on an unknown cursor and on a tail that does not extend the head", async () => {
    const built = await buildStay();
    const urls: string[] = [];
    let unknown = false;
    let fork = false;
    const served = await serve(closers, (path) => {
      urls.push(path);
      if (path.includes("after=") && unknown) {
        return {
          status: 404,
          body: {
            error: { code: "export_after_unknown", message: "after is not a record on this chain" }
          }
        };
      }
      if (path.includes("after=") && fork) {
        const genesis = built.prefix[0];
        if (genesis === undefined) {
          throw new Error("missing genesis");
        }
        return { status: 200, body: chainBody([genesis], built.keys) };
      }
      if (path.includes("after=")) {
        return { status: 200, body: chainBody([], built.keys) };
      }
      return { status: 200, body: chainBody(built.prefix, built.keys) };
    });
    let fed = 0;
    const hooks = countingHooks(() => {
      fed += 1;
    });
    const first = await fetchChain(porchPins(built, served.url), null, bareFetch, hooks);
    expect(first.hold.phase).toBe("verified");
    unknown = true;
    fed = 0;
    const beforeUnknown = urls.length;
    const reset = await fetchChain(porchPins(built, served.url), first, bareFetch, hooks);
    expect(reset.hold.phase).toBe("verified");
    expect(fed).toBe(built.prefix.length);
    expect(urls.slice(beforeUnknown)).toEqual([
      `/chain/export?after=${built.headCid}`,
      "/chain/export"
    ]);
    unknown = false;
    fork = true;
    fed = 0;
    const beforeFork = urls.length;
    const rejected = await fetchChain(porchPins(built, served.url), reset, bareFetch, hooks);
    expect(rejected.hold.phase).toBe("verified");
    expect(fed).toBe(built.prefix.length);
    expect(urls.slice(beforeFork)).toEqual([
      `/chain/export?after=${built.headCid}`,
      "/chain/export"
    ]);
    expect(illegalReceivers).toBe(0);
  });

  it("fails a tail whose extending record has a flipped signature, then one full GET", async () => {
    const built = await buildStay();
    const beat = built.full[built.full.length - 1];
    if (beat === undefined) {
      throw new Error("missing heartbeat");
    }
    const urls: string[] = [];
    const served = await serve(closers, (path) => {
      urls.push(path);
      if (path.includes("after=")) {
        return { status: 200, body: chainBody([flipSignature(beat)], built.keys) };
      }
      return { status: 200, body: chainBody(built.prefix, built.keys) };
    });
    const first = await fetchChain(porchPins(built, served.url), null, bareFetch, staticHooks());
    expect(first.hold.phase).toBe("verified");
    const before = urls.length;
    const failed = await fetchChain(porchPins(built, served.url), first, bareFetch, staticHooks());
    expect(failed.hold.phase).toBe("failed");
    expect(failed.client).toBeNull();
    expect(urls.slice(before)).toEqual([`/chain/export?after=${built.headCid}`]);
    const next = await fetchChain(porchPins(built, served.url), failed, bareFetch, staticHooks());
    expect(next.hold.phase).toBe("verified");
    expect(urls.slice(before + 1)).toEqual(["/chain/export"]);
    expect(illegalReceivers).toBe(0);
  });

  it("does not verify a tail whose two records are swapped", async () => {
    const built = await buildStay();
    const chain: ChainCursor = {
      records: built.prefix.slice(),
      prev: built.headCid,
      seq: built.prefix.length
    };
    const session = arrivalSession(built.prefix);
    await appendRecord(chain, built.soul, built.door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: session,
        at: "2026-01-04T00:00:00.000Z"
      },
      residency: RESIDENCY
    });
    await appendRecord(chain, built.soul, built.door, {
      type: "attestation",
      body: {
        kind: "heartbeat",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        session_pubkey: session,
        at: "2026-01-05T00:00:00.000Z"
      },
      residency: RESIDENCY
    });
    const second = chain.records[chain.records.length - 1];
    const firstBeat = chain.records[chain.records.length - 2];
    if (second === undefined || firstBeat === undefined) {
      throw new Error("missing swapped records");
    }
    const urls: string[] = [];
    const served = await serve(closers, (path) => {
      urls.push(path);
      if (path.includes("after=")) {
        return { status: 200, body: chainBody([second, firstBeat], built.keys) };
      }
      return { status: 200, body: chainBody(built.prefix, built.keys) };
    });
    const first = await fetchChain(porchPins(built, served.url), null, bareFetch, staticHooks());
    const before = urls.length;
    const result = await fetchChain(porchPins(built, served.url), first, bareFetch, staticHooks());
    expect(urls.slice(before)).toEqual([`/chain/export?after=${built.headCid}`, "/chain/export"]);
    expect(result.hold.phase).toBe("verified");
    expect(result.client?.records).toHaveLength(built.prefix.length);
    expect(result.client?.head?.seq).toBe(built.prefix.length - 1);
    expect(illegalReceivers).toBe(0);
  });

  it("resets when a tail's first prev is an older record, not the head", async () => {
    const built = await buildStay();
    const older = built.prefix[1];
    if (older === undefined) {
      throw new Error("missing arrival");
    }
    const urls: string[] = [];
    const served = await serve(closers, (path) => {
      urls.push(path);
      if (path.includes("after=")) {
        return { status: 200, body: chainBody([older], built.keys) };
      }
      return { status: 200, body: chainBody(built.prefix, built.keys) };
    });
    const first = await fetchChain(porchPins(built, served.url), null, bareFetch, staticHooks());
    const before = urls.length;
    const reset = await fetchChain(porchPins(built, served.url), first, bareFetch, staticHooks());
    expect(reset.hold.phase).toBe("verified");
    expect(reset.client?.head?.cid).toBe(built.headCid);
    expect(urls.slice(before)).toEqual([`/chain/export?after=${built.headCid}`, "/chain/export"]);
    expect(illegalReceivers).toBe(0);
  });

  it("resets on a tail 304 when no If-None-Match was sent", async () => {
    const built = await buildStay();
    const paths: string[] = [];
    const matches: string[] = [];
    const served = await serveHandledExport((request) => {
      const path = request.url ?? "/";
      paths.push(path);
      if (path.includes("after=")) {
        const header = request.headers["if-none-match"];
        matches.push(typeof header === "string" ? header : "");
        return { status: 304, body: {} };
      }
      return { status: 200, body: chainBody(built.prefix, built.keys) };
    });
    closers.push(served.close);
    const first = await fetchChain(porchPins(built, served.url), null, bareFetch, staticHooks());
    expect(first.hold.phase).toBe("verified");
    const before = paths.length;
    const reset = await fetchChain(porchPins(built, served.url), first, bareFetch, staticHooks());
    expect(matches).toEqual([""]);
    expect(paths.slice(before)).toEqual([`/chain/export?after=${built.headCid}`, "/chain/export"]);
    expect(reset.hold.phase).toBe("verified");
    expect(reset.client).not.toBe(first.client);
    expect(illegalReceivers).toBe(0);
  });

  it("matches a full verify when a tail crosses into the next epoch", async () => {
    const stay = await buildEpochStay();
    const tailed = await serve(closers, (path) => {
      if (path.includes("after=")) {
        return { status: 200, body: chainBody(stay.tail, stay.keys) };
      }
      return { status: 200, body: chainBody(stay.prefix, stay.keys) };
    });
    const whole = await serve(closers, () => ({
      status: 200,
      body: chainBody(stay.full, stay.keys)
    }));
    const incremental = await fetchChain(
      porchPins(stay, tailed.url),
      await fetchChain(porchPins(stay, tailed.url), null, bareFetch, staticHooks()),
      bareFetch,
      staticHooks()
    );
    const fresh = await fetchChain(porchPins(stay, whole.url), null, bareFetch, staticHooks());
    expect(incremental.hold).toEqual(fresh.hold);
    const hello = "Hello";
    for (const hold of [incremental.hold, fresh.hold]) {
      expect(
        verifyText(hold, { from: "wanderer", text: hello, proof: speak(stay.session1, 1) })
      ).toBe("earlier");
      expect(
        verifyText(hold, { from: "wanderer", text: hello, proof: speak(stay.session2, 2) })
      ).toBe("verified");
      expect(
        verifyText(hold, { from: "wanderer", text: hello, proof: speak(stay.session2, 3) })
      ).toBe("checking");
      expect(verifyReaction(hold, "web-1", { emoji: "👍", proof: chip(stay.session1, 1) })).toBe(
        "earlier"
      );
      expect(verifyReaction(hold, "web-1", { emoji: "👍", proof: chip(stay.session2, 2) })).toBe(
        "verified"
      );
      expect(verifyReaction(hold, "web-1", { emoji: "👍", proof: chip(stay.session2, 3) })).toBe(
        "checking"
      );
    }
    expect(illegalReceivers).toBe(0);
  });
});

type BuiltStay = {
  soul: Ed25519Keypair;
  door: Ed25519Keypair;
  prefix: OspRecord[];
  full: OspRecord[];
  headCid: string;
  keys: Record<string, string>;
};

type ChainBody = {
  records: readonly unknown[];
  doorPublicKeys: Record<string, string>;
  blobs: Record<string, string>;
};

type EpochStay = BuiltStay & {
  tail: OspRecord[];
  session1: Ed25519Keypair;
  session2: Ed25519Keypair;
};

type ScriptReply = { status: number; body: unknown };

class CountingVerifier extends ChainVerifier {
  constructor(
    options: VerifyChainOptions | undefined,
    private readonly mark: () => void
  ) {
    super(options);
  }

  override async evaluate(raw: unknown): Promise<ChainStep> {
    this.mark();
    return super.evaluate(raw);
  }
}

function countingHooks(mark: () => void): Partial<VerifyHooks> {
  return {
    ...staticHooks(),
    createVerifier: (options) => new CountingVerifier(options, mark)
  };
}

function staticHooks(): Partial<VerifyHooks> {
  return {
    now(this: void) {
      rejectReceiver(this);
      return 0;
    },
    yield(this: void) {
      rejectReceiver(this);
      return Promise.resolve();
    }
  };
}

function chainBody(records: readonly unknown[], keys: Record<string, string>): ChainBody {
  return { records, doorPublicKeys: keys, blobs: {} };
}

function exportReply(
  path: string,
  built: BuiltStay,
  mode: { tail: "empty" | "beat" }
): ScriptReply {
  if (!path.includes("after=")) {
    return { status: 200, body: chainBody(built.prefix, built.keys) };
  }
  if (mode.tail === "beat") {
    const beat = built.full[built.full.length - 1];
    if (beat === undefined) {
      throw new Error("missing heartbeat");
    }
    return { status: 200, body: chainBody([beat], built.keys) };
  }
  return { status: 200, body: chainBody([], built.keys) };
}

function porchPins(built: BuiltStay, atlasUrl: string) {
  return {
    soulPublicKey: encodePublicKey(built.soul.publicKey),
    doorId: DOOR_ID,
    doorPublicKey: encodePublicKey(built.door.publicKey),
    atlasUrl
  };
}

function doorKeys(door: Ed25519Keypair): Record<string, string> {
  return { [DOOR_ID]: encodePublicKey(door.publicKey) };
}

async function buildStay(): Promise<BuiltStay> {
  const soul = generateKeypair();
  const door = generateKeypair();
  const session = generateKeypair();
  const chain: { records: OspRecord[]; prev: string | null; seq: number } = {
    records: [],
    prev: null,
    seq: 0
  };
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
      session_pubkey: encodePublicKey(session.publicKey),
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY
  });
  const headCid = chain.prev;
  if (headCid === null) {
    throw new Error("missing head");
  }
  const prefix = chain.records.slice();
  await appendRecord(chain, soul, door, {
    type: "attestation",
    body: {
      kind: "heartbeat",
      pop_version: POP_VERSION,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: encodePublicKey(session.publicKey),
      at: "2026-01-04T00:00:00.000Z"
    },
    residency: RESIDENCY
  });
  return { soul, door, prefix, full: chain.records, headCid, keys: doorKeys(door) };
}

function serve(
  closers: Array<() => Promise<void>>,
  handler: (pathAndQuery: string) => ScriptReply
): Promise<{ url: string }> {
  return serveHandledExport((request) => handler(request.url ?? "/")).then((served) => {
    closers.push(served.close);
    return { url: served.url };
  });
}

function flipSignature(record: OspRecord): unknown {
  const bytes = Uint8Array.from(decodeBase64Url(record.sig));
  const index = bytes.length - 1;
  const last = bytes[index];
  if (last === undefined) {
    throw new Error("empty signature");
  }
  bytes[index] = last ^ 0xff;
  return { ...record, sig: encodeBase64Url(bytes) };
}

function arrivalSession(records: readonly OspRecord[]): string {
  const arrival = records[1];
  if (arrival === undefined || arrival.type !== "attestation" || arrival.body.kind !== "arrival") {
    throw new Error("missing arrival");
  }
  return arrival.body.session_pubkey;
}

function speak(session: Ed25519Keypair, epoch: number): { signed: unknown; sig: string } {
  const frame = signedOutbound({
    session,
    doorId: DOOR_ID,
    epoch,
    msgId: "out-1",
    body: { text: "Hello", channel_id: "porch" }
  });
  const { sig, ...signed } = frame;
  return { signed, sig };
}

function chip(session: Ed25519Keypair, epoch: number): { signed: unknown; sig: string } {
  const frame = signedOutbound({
    session,
    doorId: DOOR_ID,
    epoch,
    msgId: "out-r",
    body: { channel_id: "porch", reaction: { emoji: "👍", target_msg_id: "web-1" } }
  });
  const { sig, ...signed } = frame;
  return { signed, sig };
}

async function buildEpochStay(): Promise<EpochStay> {
  const soul = generateKeypair();
  const door = generateKeypair();
  const session1 = generateKeypair();
  const session2 = generateKeypair();
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
      session_pubkey: encodePublicKey(session1.publicKey),
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: RESIDENCY
  });
  const headCid = chain.prev;
  if (headCid === null) {
    throw new Error("missing head");
  }
  const prefix = chain.records.slice();
  await appendRecord(chain, soul, door, {
    type: "attestation",
    body: {
      kind: "departure",
      pop_version: POP_VERSION,
      door_id: DOOR_ID,
      epoch: 1,
      at: "2026-01-03T00:00:00.000Z"
    },
    residency: RESIDENCY
  });
  await appendRecord(chain, soul, door, {
    type: "attestation",
    body: {
      kind: "arrival",
      pop_version: POP_VERSION,
      door_id: DOOR_ID,
      epoch: 2,
      session_pubkey: encodePublicKey(session2.publicKey),
      at: "2026-01-04T00:00:00.000Z"
    },
    residency: `door:${DOOR_ID}/epoch:2`
  });
  return {
    soul,
    door,
    prefix,
    tail: chain.records.slice(prefix.length),
    full: chain.records,
    headCid,
    keys: doorKeys(door),
    session1,
    session2
  };
}
