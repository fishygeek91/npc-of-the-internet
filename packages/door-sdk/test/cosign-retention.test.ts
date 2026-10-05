/**
 * Per-epoch cosign review retention (`spec/door/api.md` — **Review retention**,
 * capability `cosign.past_epochs`): a completed review survives later arrivals (bounded)
 * and, with a durable store, Door restarts, so commits for a past epoch work while a
 * newer residency is live — authenticated by the reviewed epoch's session key.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalize,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import {
  COSIGN_STATE_FILE,
  FileCosignStateStore,
  type CosignStateStore,
  type PersistedCosignState
} from "../src/cosign-state-store.js";
import { Door, DEFAULT_COSIGN_RETAIN_EPOCHS, type CosignRetention } from "../src/door.js";
import { defaultHttpStatusForDoorError } from "../src/errors.js";
import type { HostPolicy } from "../src/policy.js";
import {
  DOOR_PROTOCOL_VERSION,
  type AttestRequest,
  type CosignCandidateShard,
  type CosignRequest
} from "../src/schemas.js";
import {
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  generateDoorKeypair,
  verifyDoorCosig
} from "../src/signing.js";

const DOOR_ID = "discord:retain";
const PREV_CID = "bagu" + "a".repeat(57);
const T0 = Date.parse("2026-10-05T00:00:00.000Z");

const policy: HostPolicy = {
  community: {
    name: "Retention Guild",
    description: "Per-epoch cosign retention tests.",
    platform: "discord",
    invitation_required: false
  },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual", "cosign.past_epochs"],
  // shard_05 is always rejected by the host.
  decideShard: (shard) => (shard.shard_id === "shard_05" ? "rejected" : "approved")
};

/** Mutable clock shared by the Door and request `issued_at` (freshness stays valid). */
class StepClock {
  constructor(public ms: number) {}
  now(): string {
    return new Date(this.ms).toISOString();
  }
}

type World = {
  door: Door;
  clock: StepClock;
  soul: Ed25519Keypair;
  doorKeypair: Ed25519Keypair;
  /** Session keypair per epoch (stand-in for the runtime's per-epoch derivation). */
  sessions: Map<number, Ed25519Keypair>;
};

function newWorld(options?: {
  retention?: CosignRetention;
  store?: CosignStateStore;
  base?: Pick<World, "clock" | "soul" | "doorKeypair" | "sessions">;
}): World {
  const clock = options?.base?.clock ?? new StepClock(T0);
  const soul = options?.base?.soul ?? generateKeypair();
  const doorKeypair = options?.base?.doorKeypair ?? generateDoorKeypair();
  const door = new Door({
    doorId: DOOR_ID,
    doorKeypair,
    soulPublicKey: soul.publicKey,
    clock,
    policy,
    ...(options?.retention !== undefined ? { cosignRetention: options.retention } : {}),
    ...(options?.store !== undefined ? { cosignStateStore: options.store } : {})
  });
  return { door, clock, soul, doorKeypair, sessions: options?.base?.sessions ?? new Map() };
}

function sessionFor(world: World, epoch: number): Ed25519Keypair {
  let session = world.sessions.get(epoch);
  if (session === undefined) {
    session = generateKeypair();
    world.sessions.set(epoch, session);
  }
  return session;
}

function attestCore(kind: AttestRequest["kind"], epoch: number): string {
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.2",
      seq: 1,
      prev: "bafyprev",
      type: "attestation",
      body: { kind, door_id: DOOR_ID, epoch },
      residency: `door:${DOOR_ID}/epoch:${String(epoch)}`
    })
  );
}

async function attest(world: World, epoch: number, kind: "arrival" | "departure"): Promise<void> {
  const session = sessionFor(world, epoch);
  const fields: Omit<AttestRequest, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: DOOR_ID,
    epoch,
    kind,
    core: attestCore(kind, epoch),
    session_pubkey: encodePublicKey(session.publicKey),
    issued_at: world.clock.now()
  };
  const key = kind === "arrival" ? world.soul.privateKey : session.privateKey;
  await world.door.attest({
    ...fields,
    sig: encodeSignature(sign(attestSigningPayload(fields), key))
  });
}

function shardsFor(epoch: number): CosignCandidateShard[] {
  return Array.from({ length: 5 }, (_, i) => ({
    shard_id: `shard_${String(i + 1).padStart(2, "0")}`,
    text: `Epoch ${String(epoch)} memory ${String(i + 1)}.`
  }));
}

function reviewRequest(
  world: World,
  epoch: number,
  signer = sessionFor(world, epoch)
): Extract<CosignRequest, { phase: "review" }> {
  const fields: Omit<Extract<CosignRequest, { phase: "review" }>, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    phase: "review",
    door_id: DOOR_ID,
    epoch,
    session_pubkey: encodePublicKey(signer.publicKey),
    shards: shardsFor(epoch),
    issued_at: world.clock.now()
  };
  return {
    ...fields,
    sig: encodeSignature(sign(cosignReviewSigningPayload(fields), signer.privateKey))
  };
}

/** Canonical `memory.shard` core for shard `index` (1-based) of `epoch` at `seq`. */
function memoryCore(epoch: number, index: number, seq: number, residencyEpoch = epoch): string {
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.1",
      seq,
      prev: PREV_CID,
      type: "memory",
      body: { kind: "shard", text: `Epoch ${String(epoch)} memory ${String(index)}.` },
      residency: `door:${DOOR_ID}/epoch:${String(residencyEpoch)}`
    })
  );
}

function commitRequest(
  world: World,
  args: { epoch: number; index: number; seq: number; core?: string; signer?: Ed25519Keypair }
): Extract<CosignRequest, { phase: "commit" }> {
  const signer = args.signer ?? sessionFor(world, args.epoch);
  const fields: Omit<Extract<CosignRequest, { phase: "commit" }>, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    phase: "commit",
    door_id: DOOR_ID,
    epoch: args.epoch,
    session_pubkey: encodePublicKey(signer.publicKey),
    shard_id: `shard_${String(args.index).padStart(2, "0")}`,
    core: args.core ?? memoryCore(args.epoch, args.index, args.seq),
    issued_at: world.clock.now()
  };
  return {
    ...fields,
    sig: encodeSignature(sign(cosignCommitSigningPayload(fields), signer.privateKey))
  };
}

/** arrive → review → depart for `epoch`. */
async function residency(world: World, epoch: number): Promise<void> {
  await attest(world, epoch, "arrival");
  await world.door.cosign(reviewRequest(world, epoch));
  await attest(world, epoch, "departure");
}

describe("cosign review retention (cosign.past_epochs)", () => {
  it("commits a past epoch's approved shard while a newer residency is live", async () => {
    const world = newWorld();
    await residency(world, 1);
    await attest(world, 2, "arrival"); // epoch 2 is live
    expect(world.door.getActiveEpoch()).toBe(2);

    world.clock.ms += 24 * 60 * 60 * 1000; // a full default quarantine window later
    const core = memoryCore(1, 1, 10);
    const response = await world.door.cosign(commitRequest(world, { epoch: 1, index: 1, seq: 10 }));
    expect(response).toMatchObject({ phase: "commit", epoch: 1, shard_id: "shard_01" });
    if (response.phase !== "commit") throw new Error("unreachable");
    expect(verifyDoorCosig(core, response.door_cosig, world.doorKeypair.publicKey)).toBe(true);

    // Idempotent retry (lost reply) still works for the past epoch; reuse does not.
    await expect(
      world.door.cosign(commitRequest(world, { epoch: 1, index: 1, seq: 10 }))
    ).resolves.toEqual(response);
    await expect(
      world.door.cosign(
        commitRequest(world, { epoch: 1, index: 1, seq: 10, core: memoryCore(1, 1, 9) })
      )
    ).rejects.toMatchObject({ code: "shard_not_approved" });

    // The live epoch's own review is unaffected.
    await expect(world.door.cosign(reviewRequest(world, 2))).resolves.toMatchObject({
      phase: "review",
      epoch: 2
    });
    expect(world.door.getRetainedReviewEpochs()).toEqual([1, 2]);
  });

  it("past-epoch commits keep every binding rule (session key, approval, residency)", async () => {
    const world = newWorld();
    await residency(world, 1);
    await attest(world, 2, "arrival");

    // Signed with the live epoch's session key instead of the reviewed epoch's.
    await expect(
      world.door.cosign(
        commitRequest(world, { epoch: 1, index: 1, seq: 10, signer: sessionFor(world, 2) })
      )
    ).rejects.toMatchObject({ code: "session_invalid" });
    // Right session_pubkey, forged signature.
    const forged = commitRequest(world, { epoch: 1, index: 1, seq: 10 });
    await expect(
      world.door.cosign({
        ...forged,
        sig: commitRequest(world, { epoch: 1, index: 2, seq: 10 }).sig
      })
    ).rejects.toMatchObject({ code: "signature_invalid" });
    // Host-rejected shard of the past epoch.
    await expect(
      world.door.cosign(commitRequest(world, { epoch: 1, index: 5, seq: 10 }))
    ).rejects.toMatchObject({ code: "shard_not_approved" });
    // Core bound to another epoch's residency.
    await expect(
      world.door.cosign(
        commitRequest(world, { epoch: 1, index: 1, seq: 10, core: memoryCore(1, 1, 10, 2) })
      )
    ).rejects.toMatchObject({ code: "shard_invalid" });
  });

  it("rejects reviews for a past epoch, even a retry of its completed review", async () => {
    const world = newWorld();
    await attest(world, 1, "arrival");
    const first = await world.door.cosign(reviewRequest(world, 1));
    await attest(world, 1, "departure");
    // Before the next arrival a retry still replays (lost reply).
    world.clock.ms += 1_000;
    await expect(world.door.cosign(reviewRequest(world, 1))).resolves.toEqual(first);

    await attest(world, 2, "arrival");
    await expect(world.door.cosign(reviewRequest(world, 1))).rejects.toMatchObject({
      code: "epoch_closed"
    });
  });

  it("commit for a past epoch with no retained review → review_not_retained (410)", async () => {
    const world = newWorld();
    await attest(world, 1, "arrival"); // epoch 1 never reviewed (abandoned residency)
    await attest(world, 2, "arrival");
    const request = commitRequest(world, { epoch: 1, index: 1, seq: 10 });
    await expect(world.door.cosign(request)).rejects.toMatchObject({
      code: "review_not_retained",
      httpStatus: 410
    });
    expect(defaultHttpStatusForDoorError("review_not_retained")).toBe(410);
    // The live epoch before its review is still review_pending (retryable).
    await expect(
      world.door.cosign(commitRequest(world, { epoch: 2, index: 1, seq: 10 }))
    ).rejects.toMatchObject({ code: "review_pending" });
  });

  it("evicts the lowest epochs beyond maxEpochs and reviews older than maxAgeMs", async () => {
    expect(DEFAULT_COSIGN_RETAIN_EPOCHS).toBe(16);
    const world = newWorld({ retention: { maxEpochs: 2, maxAgeMs: 3_600_000 } });
    for (const epoch of [1, 2, 3]) {
      await residency(world, epoch);
    }
    expect(world.door.getRetainedReviewEpochs()).toEqual([2, 3]);
    await expect(
      world.door.cosign(commitRequest(world, { epoch: 1, index: 1, seq: 10 }))
    ).rejects.toMatchObject({ code: "review_not_retained" });
    await expect(
      world.door.cosign(commitRequest(world, { epoch: 2, index: 1, seq: 10 }))
    ).resolves.toMatchObject({ phase: "commit" });

    world.clock.ms += 3_600_001;
    expect(world.door.getRetainedReviewEpochs()).toEqual([]);
    await attest(world, 4, "arrival");
    await expect(
      world.door.cosign(commitRequest(world, { epoch: 3, index: 1, seq: 10 }))
    ).rejects.toMatchObject({ code: "review_not_retained" });
    expect(() => newWorld({ retention: { maxEpochs: 0 } })).toThrow(RangeError);
  });

  it("persists retained reviews and commits; a restarted Door commits past epochs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "door-state-"));
    const store = new FileCosignStateStore(dir);
    const first = newWorld({ store });
    await residency(first, 1);
    await attest(first, 2, "arrival");
    const committed = await first.door.cosign(
      commitRequest(first, { epoch: 1, index: 1, seq: 10 })
    );

    const raw = JSON.parse(await readFile(join(dir, COSIGN_STATE_FILE), "utf8")) as {
      door_id: string;
      epochs: Array<{ epoch: number; approved: Array<{ text: string }> }>;
    };
    expect(raw.door_id).toBe(DOOR_ID);
    expect(raw.epochs.map((entry) => entry.epoch)).toEqual([1]);
    // Only approved text is stored — the host-rejected shard never touches disk.
    expect(JSON.stringify(raw)).not.toContain("Epoch 1 memory 5.");
    expect(raw.epochs[0]?.approved).toHaveLength(4);

    // Restart: new Door process, same state dir, no arrival yet (lastKnownEpoch lost).
    const second = newWorld({ store: new FileCosignStateStore(dir), base: first });
    expect(second.door.getRetainedReviewEpochs()).toEqual([1]);
    await expect(
      second.door.cosign(commitRequest(second, { epoch: 1, index: 2, seq: 11 }))
    ).resolves.toMatchObject({ phase: "commit", shard_id: "shard_02" });
    // Single-use survives the restart: same-seq identical core replays, lower seq refused.
    await expect(
      second.door.cosign(commitRequest(second, { epoch: 1, index: 1, seq: 10 }))
    ).resolves.toEqual(committed);
    await expect(
      second.door.cosign(
        commitRequest(second, { epoch: 1, index: 1, seq: 10, core: memoryCore(1, 1, 8) })
      )
    ).rejects.toMatchObject({ code: "shard_not_approved" });
    // A restored review is not replayable (its key embeds unpersisted rejected text).
    await expect(second.door.cosign(reviewRequest(second, 1))).rejects.toMatchObject({
      code: "epoch_closed"
    });

    // And again after the newer residency re-arrives at the restarted Door.
    await attest(second, 3, "arrival");
    await expect(
      second.door.cosign(commitRequest(second, { epoch: 1, index: 3, seq: 12 }))
    ).resolves.toMatchObject({ phase: "commit", shard_id: "shard_03" });
  });

  it("refuses persisted state of another door or a corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "door-state-"));
    const foreign: PersistedCosignState = { version: 1, door_id: "discord:other", epochs: [] };
    await writeFile(join(dir, COSIGN_STATE_FILE), JSON.stringify(foreign), "utf8");
    expect(() => newWorld({ store: new FileCosignStateStore(dir) })).toThrow(/discord:other/);
    await writeFile(join(dir, COSIGN_STATE_FILE), "{not json", "utf8");
    expect(() => newWorld({ store: new FileCosignStateStore(dir) })).toThrow();
    await writeFile(join(dir, COSIGN_STATE_FILE), JSON.stringify({ version: 2 }), "utf8");
    expect(() => newWorld({ store: new FileCosignStateStore(dir) })).toThrow(/invalid persisted/);
    // A missing file is an empty state.
    const empty = newWorld({ store: new FileCosignStateStore(join(dir, "fresh")) });
    expect(empty.door.getRetainedReviewEpochs()).toEqual([]);
  });

  it("a failed save returns no co-signature and leaves no single-use record", async () => {
    let failSaves = false;
    const saved: PersistedCosignState[] = [];
    const store: CosignStateStore = {
      load: () => null,
      save: (state) => {
        if (failSaves) throw new Error("ENOSPC");
        saved.push(state);
      }
    };
    const world = newWorld({ store });
    await residency(world, 1);
    failSaves = true;
    await expect(
      world.door.cosign(commitRequest(world, { epoch: 1, index: 1, seq: 10 }))
    ).rejects.toMatchObject({ code: "internal_error", httpStatus: 500 });
    failSaves = false;
    // The same commit at a lower seq is accepted: the failed attempt left no record.
    const ok = await world.door.cosign(commitRequest(world, { epoch: 1, index: 1, seq: 9 }));
    expect(ok.phase).toBe("commit");
    expect(saved.at(-1)?.epochs[0]?.committed.map((entry) => entry.seq)).toEqual([9]);

    // A failed review save leaves the epoch unreviewed (a retry re-runs it).
    await attest(world, 2, "arrival");
    failSaves = true;
    await expect(world.door.cosign(reviewRequest(world, 2))).rejects.toMatchObject({
      code: "internal_error"
    });
    expect(world.door.getRetainedReviewEpochs()).toEqual([1]);
    failSaves = false;
    await expect(world.door.cosign(reviewRequest(world, 2))).resolves.toMatchObject({
      phase: "review"
    });
  });
});
