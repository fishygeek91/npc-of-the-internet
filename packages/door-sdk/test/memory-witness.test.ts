import {
  contentAddressSideBlob,
  createRecord,
  decodeSignature,
  encodeJournalBlob,
  encodePublicKey,
  encodeShardTextBlob,
  generateKeypair,
  verify,
  verifyRecord
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { DoorError } from "../src/errors.js";
import { DEFAULT_MAX_MEMORY_ATTESTS } from "../src/door.js";
import { DOOR_PROTOCOL_VERSION, HelloResponseSchema } from "../src/schemas.js";
import { attestResponseSigningPayload, verifyDoorCosig } from "../src/signing.js";
import { HttpDoorConnection } from "../src/transports/http-client.js";
import { HttpDoorServer } from "../src/transports/http.js";
import type { WitnessMemory, WitnessVerdict } from "../src/witness.js";
import {
  arrivalRequest,
  arrive,
  attestCore,
  coreString,
  createHarness,
  deferred,
  departureRequest,
  DOOR_ID,
  EPOCH,
  journalCoreFields,
  memoryRequest,
  NOW,
  residencyFor,
  sessionAttest,
  shardCoreFields,
  type Harness,
  outboundFrame
} from "./helpers/door-harness.js";

const SHARD_TEXT = "Someone here taught me the names of three night birds.";

/** Relay one community message inbound and deliver one Wanderer line outbound. */
function converse(h: Harness): void {
  h.door.createInboundFrame({
    msg_id: "in_1",
    body: {
      text: "Listen:\nthe nightjar, the owl,\tthe whip-poor-will.",
      author_id: "u_1",
      author_display: "Wren"
    }
  });
  h.door.handleOutbound(outboundFrame(h, "out_1", { text: "I will remember those birds." }));
}

async function hello(h: Harness): Promise<string[]> {
  const response = await h.door.hello({
    protocol_version: DOOR_PROTOCOL_VERSION,
    soul_pubkey: encodePublicKey(h.soul.publicKey)
  });
  return response.capabilities;
}

describe("memory attest — witnessed memories", () => {
  it("witnesses a shard: cosig verifies over core, witness judged the Door's own transcript", async () => {
    const h = createHarness();
    await arrive(h);
    converse(h);

    const fields = await shardCoreFields(SHARD_TEXT);
    const request = memoryRequest(h, fields, SHARD_TEXT);
    const response = await h.door.attest(request);

    expect(response).toMatchObject({ door_id: DOOR_ID, epoch: EPOCH, kind: "memory" });
    expect(verifyDoorCosig(request.core, response.door_cosig, h.doorKeypair.publicKey)).toBe(true);
    expect(
      verify(
        attestResponseSigningPayload(response),
        decodeSignature(response.door_sig),
        h.doorKeypair.publicKey
      )
    ).toBe(true);

    expect(h.witnessCalls).toHaveLength(1);
    expect(h.witnessCalls[0]).toEqual({
      doorId: DOOR_ID,
      epoch: EPOCH,
      kind: "shard",
      text: SHARD_TEXT,
      transcript: [
        {
          role: "community",
          author: "Wren",
          text: "Listen:\nthe nightjar, the owl,\tthe whip-poor-will.",
          at: NOW
        },
        { role: "wanderer", text: "I will remember those birds.", at: NOW }
      ],
      witnessedShards: []
    });

    // The cosig makes a valid osp/0.2 soulchain memory record.
    const { record } = await createRecord({
      spec: "osp/0.2",
      seq: fields.seq,
      prev: fields.prev,
      type: "memory",
      body: fields.body as never,
      residency: fields.residency,
      cosigners: [response.door_cosig],
      soulPrivateKey: h.soul.privateKey
    });
    const verified = await verifyRecord(record, {
      soulPublicKey: h.soul.publicKey,
      doorPublicKeys: { [DOOR_ID]: h.doorKeypair.publicKey }
    });
    expect(verified.record.type).toBe("memory");
  });

  it("witnesses a journal longer than a shard may be, judged against the witnessed shards", async () => {
    const h = createHarness();
    await arrive(h);
    await h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT));
    const journal = `# Lantern\n\n${"I stayed a while and listened. ".repeat(60)}`;
    expect([...journal].length).toBeGreaterThan(500);

    const fields = await journalCoreFields(journal);
    const request = memoryRequest(h, fields, journal);
    const response = await h.door.attest(request);

    expect(verifyDoorCosig(request.core, response.door_cosig, h.doorKeypair.publicKey)).toBe(true);
    expect(h.witnessCalls.map((call) => [call.kind, call.text])).toEqual([
      ["shard", SHARD_TEXT],
      ["journal", journal]
    ]);
    expect(h.witnessCalls[1]?.witnessedShards).toEqual([SHARD_TEXT]);
    // Empty record: the witness still gets asked (it decides; the Door does not pre-judge).
    expect(h.witnessCalls[0]?.transcript).toEqual([]);
  });

  it("the witness input is a snapshot of the record at ask time", async () => {
    const gate = deferred<WitnessVerdict>();
    const h = createHarness({ witness: () => gate.promise });
    await arrive(h);
    converse(h);
    const pending = h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT));
    await waitFor(() => h.witnessCalls.length === 1);
    h.door.handleOutbound(outboundFrame(h, "out_2", { text: "Later words." }));
    gate.resolve({ witnessed: true });
    await pending;
    expect(h.witnessCalls[0]?.transcript).toHaveLength(2);
    expect(h.door.residencyRecordSize()).toBe(3);
  });

  describe("core binding → core_invalid (witness never asked)", () => {
    const otherText = "Something that never happened here.";

    async function expectCoreInvalid(
      build: (h: Harness) => Promise<{ core: string; text: string }>
    ): Promise<void> {
      const h = createHarness();
      await arrive(h);
      const { core, text } = await build(h);
      const request = sessionAttest(h, { kind: "memory", core, text });
      await expect(h.door.attest(request)).rejects.toMatchObject({
        code: "core_invalid",
        httpStatus: 400
      });
      expect(h.witnessCalls).toEqual([]);
    }

    it("text_hash / text_cid of other text", async () => {
      await expectCoreInvalid(async () => ({
        core: coreString(await shardCoreFields(otherText)),
        text: SHARD_TEXT
      }));
    });

    it("right text_hash but text_cid of other text", async () => {
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        const other = await contentAddressSideBlob(encodeShardTextBlob(otherText));
        return {
          core: coreString({ ...fields, body: { ...fields.body, text_cid: other.cid } }),
          text: SHARD_TEXT
        };
      });
    });

    it("right text_cid but text_hash of other text", async () => {
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        const other = await contentAddressSideBlob(encodeShardTextBlob(otherText));
        return {
          core: coreString({ ...fields, body: { ...fields.body, text_hash: other.hash } }),
          text: SHARD_TEXT
        };
      });
    });

    it("journal hash computed over the raw text instead of the side blob", async () => {
      await expectCoreInvalid(async () => {
        const fields = await journalCoreFields(SHARD_TEXT);
        const raw = await contentAddressSideBlob(new TextEncoder().encode(SHARD_TEXT));
        return {
          core: coreString({
            ...fields,
            body: { ...fields.body, journal_cid: raw.cid, journal_hash: raw.hash }
          }),
          text: SHARD_TEXT
        };
      });
    });

    it("inline text body (legacy osp/0.1 shard shape)", async () => {
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        return {
          core: coreString({
            ...fields,
            body: { kind: "shard", text: SHARD_TEXT, distilled_at: NOW }
          }),
          text: SHARD_TEXT
        };
      });
    });

    it("inline text alongside valid side-blob fields", async () => {
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        return {
          core: coreString({ ...fields, body: { ...fields.body, text: SHARD_TEXT } }),
          text: SHARD_TEXT
        };
      });
    });

    it("extra body fields (tags, shard-embedded journal refs)", async () => {
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        return {
          core: coreString({ ...fields, body: { ...fields.body, tags: ["birds"] } }),
          text: SHARD_TEXT
        };
      });
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        const journal = await contentAddressSideBlob(encodeJournalBlob("j"));
        return {
          core: coreString({
            ...fields,
            body: { ...fields.body, journal_cid: journal.cid, journal_hash: journal.hash }
          }),
          text: SHARD_TEXT
        };
      });
    });

    it("missing body fields", async () => {
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        const body = { ...fields.body };
        delete body.distilled_at;
        return { core: coreString({ ...fields, body }), text: SHARD_TEXT };
      });
    });

    it("journal body under kind shard, and kinds the Door never witnesses", async () => {
      await expectCoreInvalid(async () => {
        const fields = await journalCoreFields(SHARD_TEXT);
        return {
          core: coreString({ ...fields, body: { ...fields.body, kind: "shard" } }),
          text: SHARD_TEXT
        };
      });
      await expectCoreInvalid(async () => {
        const fields = await shardCoreFields(SHARD_TEXT);
        return {
          core: coreString({ ...fields, body: { kind: "rejected", category: "witness_private" } }),
          text: SHARD_TEXT
        };
      });
    });

    it("residency of another Door or another epoch", async () => {
      await expectCoreInvalid(async () => ({
        core: coreString({
          ...(await shardCoreFields(SHARD_TEXT)),
          residency: residencyFor(EPOCH, "web:elsewhere")
        }),
        text: SHARD_TEXT
      }));
      await expectCoreInvalid(async () => ({
        core: coreString({
          ...(await shardCoreFields(SHARD_TEXT)),
          residency: residencyFor(EPOCH - 1)
        }),
        text: SHARD_TEXT
      }));
    });

    it("osp/0.1 spec, attestation type, or a non-canonical core", async () => {
      await expectCoreInvalid(async () => ({
        core: coreString({ ...(await shardCoreFields(SHARD_TEXT)), spec: "osp/0.1" }),
        text: SHARD_TEXT
      }));
      await expectCoreInvalid(async () => ({
        core: coreString({ ...(await shardCoreFields(SHARD_TEXT)), type: "attestation" }),
        text: SHARD_TEXT
      }));
      await expectCoreInvalid(async () => ({
        core: JSON.stringify(await shardCoreFields(SHARD_TEXT), null, 1),
        text: SHARD_TEXT
      }));
      await expectCoreInvalid(async () => ({ core: "[]", text: SHARD_TEXT }));
      await expectCoreInvalid(async () => ({ core: "{not json", text: SHARD_TEXT }));
    });

    it("an attestation core submitted as kind memory", async () => {
      await expectCoreInvalid(async () => ({
        core: attestCore("memory", EPOCH),
        text: SHARD_TEXT
      }));
    });

    it("shard text over 500 code points (even when the hash matches)", async () => {
      const long = "🌲".repeat(501);
      await expectCoreInvalid(async () => {
        // Same side-blob encoding, computed without the shard cap.
        const { cid, hash } = await contentAddressSideBlob(encodeJournalBlob(long));
        const fields = await shardCoreFields("placeholder");
        return {
          core: coreString({ ...fields, body: { ...fields.body, text_cid: cid, text_hash: hash } }),
          text: long
        };
      });
      // Exactly 500 code points (1000 UTF-16 units) is fine.
      const h = createHarness();
      await arrive(h);
      const ok = "🌲".repeat(500);
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(ok), ok))
      ).resolves.toMatchObject({
        kind: "memory"
      });
    });
  });

  it("memory without text at the Door core → invalid_request (schema-bypassing callers)", async () => {
    const h = createHarness();
    await arrive(h);
    const request = sessionAttest(h, {
      kind: "memory",
      core: coreString(await shardCoreFields(SHARD_TEXT))
    });
    await expect(h.door.attest(request)).rejects.toMatchObject({ code: "invalid_request" });
    expect(h.witnessCalls).toEqual([]);
  });

  describe("a Door without a witness", () => {
    it("answers unsupported_kind and never advertises attest.memory", async () => {
      const h = createHarness({
        witness: null,
        policy: { capabilities: ["session.text", "attest", "attest.memory"] }
      });
      expect(h.door.witnessesMemories()).toBe(false);
      expect(await hello(h)).toEqual(["session.text", "attest"]);
      await arrive(h);
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({ code: "unsupported_kind", httpStatus: 400 });
      // Presence attests still work.
      await expect(h.door.attest(departureRequest(h))).resolves.toMatchObject({
        kind: "departure"
      });
    });

    it("a Door with a witness advertises attest.memory exactly once", async () => {
      const plain = createHarness();
      expect(await hello(plain)).toEqual(["session.text", "heartbeat", "attest", "attest.memory"]);
      const listed = createHarness({
        policy: { capabilities: ["attest.memory", "attest", "attest.memory"] }
      });
      expect(await hello(listed)).toEqual(["attest", "attest.memory"]);
    });
  });

  describe("witness verdicts", () => {
    it("decline → witness_declined 422 with details.reason, and no cosig", async () => {
      for (const reason of ["ungrounded", "private", "harmful", "manipulation", "other"] as const) {
        const h = createHarness({ witness: async () => ({ witnessed: false, reason }) });
        await arrive(h);
        const error = await h.door
          .attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
          .then(
            () => null,
            (caught: unknown) => caught
          );
        expect(error).toBeInstanceOf(DoorError);
        expect(error).toMatchObject({
          code: "witness_declined",
          httpStatus: 422,
          details: { reason }
        });
      }
    });

    it("a reason outside the spec set is reported as other", async () => {
      const h = createHarness({
        witness: async () => ({ witnessed: false, reason: "too sad" }) as unknown as WitnessVerdict
      });
      await arrive(h);
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({ code: "witness_declined", details: { reason: "other" } });
    });

    it("witness throws → witness_unavailable 503 (an outage is never a decline)", async () => {
      const h = createHarness({
        witness: async () => {
          throw new Error("model timeout");
        }
      });
      await arrive(h);
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({
        code: "witness_unavailable",
        httpStatus: 503,
        message: expect.stringContaining("model timeout") as unknown as string
      });
      // Session untouched: the Wanderer can retry.
      expect(h.door.getActiveEpoch()).toBe(EPOCH);
    });

    it("a witness that throws a non-Error still yields witness_unavailable", async () => {
      const h = createHarness({
        witness: () => Promise.reject("nope" as unknown as Error)
      });
      await arrive(h);
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({ code: "witness_unavailable" });
    });

    it("malformed verdicts never produce a cosig", async () => {
      const malformed: unknown[] = [
        undefined,
        null,
        {},
        { witnessed: "true" },
        { witnessed: 1 },
        { witnessed: "false" },
        { verdict: "witness" }
      ];
      for (const verdict of malformed) {
        const h = createHarness({ witness: (async () => verdict) as unknown as WitnessMemory });
        await arrive(h);
        await expect(
          h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
        ).rejects.toMatchObject({ code: "witness_unavailable", httpStatus: 503 });
      }
    });
  });

  describe("decisions are final for the epoch", () => {
    const declineAll: WitnessMemory = async () => ({ witnessed: false, reason: "private" });

    it("a repeat of a declined text gets the same decline without asking the witness", async () => {
      const h = createHarness({ witness: declineAll });
      await arrive(h);
      const fields = await shardCoreFields(SHARD_TEXT);
      await expect(h.door.attest(memoryRequest(h, fields, SHARD_TEXT))).rejects.toMatchObject({
        code: "witness_declined",
        details: { reason: "private" }
      });
      // Same text under another record position (a retry after a crash) — still declined.
      for (const core of [fields, { ...fields, seq: fields.seq + 3 }]) {
        await expect(h.door.attest(memoryRequest(h, core, SHARD_TEXT))).rejects.toMatchObject({
          code: "witness_declined",
          httpStatus: 422,
          details: { reason: "private" }
        });
      }
      expect(h.witnessCalls).toHaveLength(1);
    });

    it("a repeat of a witnessed text is co-signed again without asking (no duplicate shard)", async () => {
      const h = createHarness();
      await arrive(h);
      const request = memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT);
      await h.door.attest(request);
      const again = await h.door.attest(request);
      expect(verifyDoorCosig(request.core, again.door_cosig, h.doorKeypair.publicKey)).toBe(true);
      expect(h.witnessCalls).toHaveLength(1);
      const journal = "I learned three night birds.";
      await h.door.attest(memoryRequest(h, await journalCoreFields(journal), journal));
      expect(h.witnessCalls[1]?.witnessedShards).toEqual([SHARD_TEXT]);
    });

    it("the same text as shard and as journal is two decisions", async () => {
      const h = createHarness({
        witness: async (input) =>
          input.kind === "shard" ? { witnessed: true } : { witnessed: false, reason: "other" }
      });
      await arrive(h);
      await h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT));
      await expect(
        h.door.attest(memoryRequest(h, await journalCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({ code: "witness_declined", details: { reason: "other" } });
      expect(h.witnessCalls.map((call) => call.kind)).toEqual(["shard", "journal"]);
    });

    it("an outage is not a decision: the text is asked again", async () => {
      let calls = 0;
      const h = createHarness({
        witness: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("model timeout");
          }
          return { witnessed: true };
        }
      });
      await arrive(h);
      const request = memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT);
      await expect(h.door.attest(request)).rejects.toMatchObject({ code: "witness_unavailable" });
      await expect(h.door.attest(request)).resolves.toMatchObject({ kind: "memory" });
      expect(h.witnessCalls).toHaveLength(2);
    });

    it("decisions end with the epoch (departure and supersession)", async () => {
      const h = createHarness({ witness: declineAll });
      await arrive(h);
      const declined = { code: "witness_declined" };
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject(declined);
      await h.door.attest(departureRequest(h));
      await arrive(h, EPOCH + 1);
      await expect(
        h.door.attest(
          memoryRequest(h, await shardCoreFields(SHARD_TEXT, EPOCH + 1), SHARD_TEXT, EPOCH + 1)
        )
      ).rejects.toMatchObject(declined);
      await arrive(h, EPOCH + 2);
      await expect(
        h.door.attest(
          memoryRequest(h, await shardCoreFields(SHARD_TEXT, EPOCH + 2), SHARD_TEXT, EPOCH + 2)
        )
      ).rejects.toMatchObject(declined);
      expect(h.witnessCalls.map((call) => call.epoch)).toEqual([EPOCH, EPOCH + 1, EPOCH + 2]);
    });

    it("a verdict that arrives after the epoch ended is not carried into the next one", async () => {
      const gate = deferred<WitnessVerdict>();
      let first = true;
      const h = createHarness({
        witness: () => {
          if (first) {
            first = false;
            return gate.promise;
          }
          return Promise.resolve({ witnessed: true });
        }
      });
      await arrive(h);
      const pending = h.door.attest(
        memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT)
      );
      await waitFor(() => h.witnessCalls.length === 1);
      await arrive(h, EPOCH + 1);
      gate.resolve({ witnessed: true });
      await expect(pending).rejects.toBeInstanceOf(DoorError);
      // The new epoch has no witnessed shard, so a journal is not grounded.
      const journal = "I learned three night birds.";
      await expect(
        h.door.attest(
          memoryRequest(h, await journalCoreFields(journal, EPOCH + 1), journal, EPOCH + 1)
        )
      ).rejects.toMatchObject({ code: "witness_declined", details: { reason: "ungrounded" } });
      expect(h.witnessCalls).toHaveLength(1);
    });
  });

  describe("per-epoch witness budget", () => {
    async function attestShard(h: Harness, index: number, epoch = EPOCH): Promise<unknown> {
      const text = `Memory number ${String(index)}.`;
      return h.door.attest(memoryRequest(h, await shardCoreFields(text, epoch), text, epoch));
    }

    it(`defaults to ${String(DEFAULT_MAX_MEMORY_ATTESTS)} witness calls; past it, declined other without a call`, async () => {
      expect(DEFAULT_MAX_MEMORY_ATTESTS).toBe(32);
      const h = createHarness();
      await arrive(h);
      for (let index = 0; index < DEFAULT_MAX_MEMORY_ATTESTS; index += 1) {
        await attestShard(h, index);
      }
      await expect(attestShard(h, DEFAULT_MAX_MEMORY_ATTESTS)).rejects.toMatchObject({
        code: "witness_declined",
        httpStatus: 422,
        details: { reason: "other" },
        message: expect.stringContaining("memory budget exhausted") as unknown as string
      });
      expect(h.witnessCalls).toHaveLength(DEFAULT_MAX_MEMORY_ATTESTS);
      // Decided texts are still answered (no call needed).
      await expect(attestShard(h, 0)).resolves.toMatchObject({ kind: "memory" });
    });

    it("counts every witness call (outages and declines too), and resets each epoch", async () => {
      let calls = 0;
      const h = createHarness({
        maxMemoryAttests: 2,
        witness: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("model timeout");
          }
          return { witnessed: false, reason: "ungrounded" };
        }
      });
      await arrive(h);
      await expect(attestShard(h, 1)).rejects.toMatchObject({ code: "witness_unavailable" });
      await expect(attestShard(h, 2)).rejects.toMatchObject({ details: { reason: "ungrounded" } });
      await expect(attestShard(h, 1)).rejects.toMatchObject({
        message: expect.stringContaining("memory budget exhausted") as unknown as string
      });
      expect(h.witnessCalls).toHaveLength(2);

      await h.door.attest(departureRequest(h));
      await arrive(h, EPOCH + 1);
      await expect(attestShard(h, 1, EPOCH + 1)).rejects.toMatchObject({
        details: { reason: "ungrounded" }
      });
      expect(h.witnessCalls).toHaveLength(3);
    });

    it("maxMemoryAttests must be a non-negative integer (0 = no witness calls)", async () => {
      for (const bad of [-1, 1.5, Number.NaN]) {
        expect(() => createHarness({ maxMemoryAttests: bad })).toThrow(RangeError);
      }
      const h = createHarness({ maxMemoryAttests: 0 });
      await arrive(h);
      await expect(attestShard(h, 1)).rejects.toMatchObject({ details: { reason: "other" } });
      expect(h.witnessCalls).toEqual([]);
    });
  });

  describe("journal rules", () => {
    const JOURNAL = "# Lantern\n\nI learned three night birds here.";

    it("needs a witnessed shard first: otherwise declined ungrounded without a call", async () => {
      const h = createHarness({
        witness: async (input) =>
          input.kind === "shard" ? { witnessed: false, reason: "private" } : { witnessed: true }
      });
      await arrive(h);
      const journal = memoryRequest(h, await journalCoreFields(JOURNAL), JOURNAL);
      await expect(h.door.attest(journal)).rejects.toMatchObject({
        code: "witness_declined",
        details: { reason: "ungrounded" }
      });
      // A declined shard does not count.
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({ details: { reason: "private" } });
      await expect(h.door.attest(journal)).rejects.toMatchObject({
        details: { reason: "ungrounded" }
      });
      expect(h.witnessCalls.map((call) => call.kind)).toEqual(["shard"]);
    });

    it("at most one journal is witnessed per epoch: another is declined other without a call", async () => {
      const h = createHarness();
      await arrive(h);
      await h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT));
      const first = memoryRequest(h, await journalCoreFields(JOURNAL), JOURNAL);
      await h.door.attest(first);
      const other = `${JOURNAL}\n\nAnd one more thing.`;
      await expect(
        h.door.attest(memoryRequest(h, await journalCoreFields(other), other))
      ).rejects.toMatchObject({ code: "witness_declined", details: { reason: "other" } });
      // Retrying the witnessed journal is fine (lost response).
      await expect(h.door.attest(first)).resolves.toMatchObject({ kind: "memory" });
      expect(h.witnessCalls.map((call) => call.kind)).toEqual(["shard", "journal"]);
    });

    it("two journals racing: only one is witnessed", async () => {
      const gate = deferred<WitnessVerdict>();
      const h = createHarness({
        witness: (input) =>
          input.kind === "journal" ? gate.promise : Promise.resolve({ witnessed: true })
      });
      await arrive(h);
      await h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT));
      const other = `${JOURNAL} Again.`;
      const results = Promise.allSettled([
        h.door.attest(memoryRequest(h, await journalCoreFields(JOURNAL), JOURNAL)),
        h.door.attest(memoryRequest(h, await journalCoreFields(other), other))
      ]);
      await waitFor(() => h.witnessCalls.length === 3);
      gate.resolve({ witnessed: true });
      const settled = await results;
      expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = settled.find((result) => result.status === "rejected");
      expect(rejected?.reason).toMatchObject({ details: { reason: "other" } });
    });
  });

  describe("session checks around the witness", () => {
    it("before any arrival → session_invalid; witness not asked", async () => {
      const h = createHarness();
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({ code: "session_invalid" });
      expect(h.witnessCalls).toEqual([]);
    });

    it("wrong session key → signature_invalid; witness not asked", async () => {
      const h = createHarness();
      await arrive(h);
      const request = sessionAttest(h, {
        kind: "memory",
        core: coreString(await shardCoreFields(SHARD_TEXT)),
        text: SHARD_TEXT,
        session: generateKeypair()
      });
      await expect(h.door.attest(request)).rejects.toMatchObject({ code: "signature_invalid" });
      expect(h.witnessCalls).toEqual([]);
    });

    it("after departure → epoch_closed; witness not asked", async () => {
      const h = createHarness();
      await arrive(h);
      await h.door.attest(departureRequest(h));
      await expect(
        h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT))
      ).rejects.toMatchObject({ code: "epoch_closed", httpStatus: 409 });
      expect(h.witnessCalls).toEqual([]);
    });

    it("stale issued_at → timestamp_stale; witness not asked", async () => {
      const h = createHarness();
      await arrive(h);
      const request = sessionAttest(h, {
        kind: "memory",
        core: coreString(await shardCoreFields(SHARD_TEXT)),
        text: SHARD_TEXT,
        issuedAt: "2026-10-06T11:00:00.000Z"
      });
      await expect(h.door.attest(request)).rejects.toMatchObject({ code: "timestamp_stale" });
      expect(h.witnessCalls).toEqual([]);
    });

    it("departure during a slow witness → no cosig (epoch_closed)", async () => {
      const gate = deferred<WitnessVerdict>();
      const h = createHarness({ witness: () => gate.promise });
      await arrive(h);
      const pending = h.door.attest(
        memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT)
      );
      await waitFor(() => h.witnessCalls.length === 1);
      await h.door.attest(departureRequest(h));
      gate.resolve({ witnessed: true });
      await expect(pending).rejects.toMatchObject({ code: "epoch_closed" });
    });

    it("supersession during a slow witness → no cosig", async () => {
      const gate = deferred<WitnessVerdict>();
      const h = createHarness({ witness: () => gate.promise });
      await arrive(h);
      const pending = h.door.attest(
        memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT)
      );
      await waitFor(() => h.witnessCalls.length === 1);
      await arrive(h, EPOCH + 1, generateKeypair());
      gate.resolve({ witnessed: true });
      const error = await pending.then(
        () => null,
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(DoorError);
      expect(["epoch_mismatch", "session_invalid", "epoch_closed"]).toContain(
        (error as DoorError).code
      );
    });
  });

  describe("the residency record (witness input)", () => {
    it("is cleared on departure, and the next residency starts empty", async () => {
      const h = createHarness();
      await arrive(h);
      converse(h);
      expect(h.door.residencyRecordSize()).toBe(2);
      await h.door.attest(departureRequest(h));
      expect(h.door.residencyRecordSize()).toBe(0);

      await arrive(h, EPOCH + 1);
      await h.door.attest(
        memoryRequest(h, await shardCoreFields(SHARD_TEXT, EPOCH + 1), SHARD_TEXT, EPOCH + 1)
      );
      expect(h.witnessCalls[0]?.transcript).toEqual([]);
    });

    it("is cleared on supersession", async () => {
      const h = createHarness();
      await arrive(h);
      converse(h);
      const next = generateKeypair();
      await arrive(h, EPOCH + 1, next);
      expect(h.door.residencyRecordSize()).toBe(0);
    });

    it("records each accepted outbound text once; replays, bad sigs and reaction-only frames add nothing", async () => {
      const h = createHarness();
      await arrive(h);
      const frame = outboundFrame(h, "out_1", { text: "once" });
      h.door.handleOutbound(frame);
      expect(() => h.door.handleOutbound(frame)).toThrow(/msg_replay/);
      expect(() =>
        h.door.handleOutbound(
          outboundFrame(h, "out_2", { text: "forged" }, { session: generateKeypair() })
        )
      ).toThrow(/signature_invalid/);
      h.door.handleOutbound(
        outboundFrame(h, "out_3", { reaction: { emoji: "🦉", target_msg_id: "in_1" } })
      );
      expect(h.door.residencyRecordSize()).toBe(1);
    });

    it("honours DoorOptions.residencyRecord budgets (most recent kept)", async () => {
      const h = createHarness({ residencyRecord: { communityChars: 10 } });
      await arrive(h);
      h.door.createInboundFrame({ msg_id: "a", body: { text: "aaaaaa", author_id: "u" } });
      h.door.createInboundFrame({ msg_id: "b", body: { text: "bbbbbb", author_id: "u" } });
      await h.door.attest(memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT));
      expect(h.witnessCalls[0]?.transcript.map((line) => line.text)).toEqual(["bbbbbb"]);
      // author_display falls back to author_id.
      expect(h.witnessCalls[0]?.transcript[0]?.author).toBe("u");
    });
  });
});

describe("memory attest over HTTP", () => {
  let server: HttpDoorServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function serve(h: Harness): Promise<{ baseUrl: string; client: HttpDoorConnection }> {
    server = new HttpDoorServer({ door: h.door });
    const { baseUrl } = await server.start();
    const client = new HttpDoorConnection({ baseUrl });
    await client.hello({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(h.soul.publicKey)
    });
    return { baseUrl, client };
  }

  async function postAttest(
    baseUrl: string,
    body: unknown
  ): Promise<{ status: number; body: { error?: { code: string; details?: unknown } } }> {
    const response = await fetch(`${baseUrl}/door/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return {
      status: response.status,
      body: (await response.json()) as { error?: { code: string; details?: unknown } }
    };
  }

  it("witnessed: the client verifies door_sig and door_cosig", async () => {
    const h = createHarness();
    const { client } = await serve(h);
    await client.attest(arrivalRequest(h));
    const request = memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT);
    const response = await client.attest(request);
    expect(verifyDoorCosig(request.core, response.door_cosig, h.doorKeypair.publicKey)).toBe(true);
  });

  it("decline → 422 witness_declined with details.reason (raw and via the client)", async () => {
    const h = createHarness({ witness: async () => ({ witnessed: false, reason: "private" }) });
    const { baseUrl, client } = await serve(h);
    await arrive(h);
    const request = memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT);

    const raw = await postAttest(baseUrl, request);
    expect(raw.status).toBe(422);
    expect(raw.body.error).toMatchObject({
      code: "witness_declined",
      details: { reason: "private" }
    });

    await expect(client.attest(request)).rejects.toMatchObject({
      code: "witness_declined",
      httpStatus: 422,
      details: { reason: "private" }
    });
  });

  it("witness outage → 503 witness_unavailable", async () => {
    const h = createHarness({
      witness: async () => {
        throw new Error("upstream 502");
      }
    });
    const { baseUrl, client } = await serve(h);
    await arrive(h);
    const request = memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT);
    expect((await postAttest(baseUrl, request)).status).toBe(503);
    await expect(client.attest(request)).rejects.toMatchObject({
      code: "witness_unavailable",
      httpStatus: 503
    });
  });

  it("schema: memory without text, or text on another kind → 400 invalid_request", async () => {
    const h = createHarness();
    const { baseUrl } = await serve(h);
    await arrive(h);
    const memory = memoryRequest(h, await shardCoreFields(SHARD_TEXT), SHARD_TEXT);
    const withoutText: Record<string, unknown> = { ...memory };
    delete withoutText.text;
    const missing = await postAttest(baseUrl, withoutText);
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe("invalid_request");

    const departure = departureRequest(h);
    const smuggled = await postAttest(baseUrl, { ...departure, text: SHARD_TEXT });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body.error?.code).toBe("invalid_request");
    expect(h.witnessCalls).toEqual([]);
    expect(h.door.getActiveEpoch()).toBe(EPOCH);
  });

  it("hello capabilities with unknown strings parse and verify", async () => {
    const h = createHarness({
      policy: { capabilities: ["session.text", "future.feature" as never] }
    });
    const { client } = await serve(h);
    const response = await client.hello({
      protocol_version: DOOR_PROTOCOL_VERSION,
      soul_pubkey: encodePublicKey(h.soul.publicKey)
    });
    expect(response.capabilities).toEqual(["session.text", "future.feature", "attest.memory"]);
    expect(HelloResponseSchema.safeParse(response).success).toBe(true);
  });
});

/** Poll until `condition` holds (the witness is awaited after async core binding). */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not met");
}
