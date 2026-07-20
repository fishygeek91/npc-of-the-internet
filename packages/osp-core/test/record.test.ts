import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/canonical.js";
import { computeCidFromCanonicalBytes } from "../src/crypto/cid.js";
import { generateKeypair, sign } from "../src/crypto/ed25519.js";
import { encodePublicKey, encodeSignature } from "../src/index.js";
import { createRecord, signCore, soulPayload, verifyRecord } from "../src/record.js";
import { SchemaError, VerificationError } from "../src/errors.js";

const PREV_CID = "bagu4eraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESIDENCY = "door:discord:g/epoch:1";

type RecordCase = {
  name: string;
  fields: {
    seq: number;
    prev: string | null;
    type: Parameters<typeof createRecord>[0]["type"];
    body: Parameters<typeof createRecord>[0]["body"];
    residency: string | null;
    cosigners: string[];
  };
  needsDoor: boolean;
};

async function createAndVerify(
  fields: RecordCase["fields"],
  needsDoor: boolean,
  soul = generateKeypair(),
  door = generateKeypair()
): Promise<{
  soul: ReturnType<typeof generateKeypair>;
  door: ReturnType<typeof generateKeypair>;
  cid: string;
  record: Awaited<ReturnType<typeof createRecord>>["record"];
}> {
  const envelope = {
    seq: fields.seq,
    prev: fields.prev,
    type: fields.type,
    body: fields.body,
    residency: fields.residency
  };

  const cosigners =
    fields.cosigners.length > 0
      ? fields.cosigners
      : needsDoor
        ? [signCore(envelope, door.privateKey)]
        : [];

  const { record, cid } = await createRecord({
    ...envelope,
    cosigners,
    soulPrivateKey: soul.privateKey
  });

  await verifyRecord(record, {
    soulPublicKey: soul.publicKey,
    doorPublicKeys: cosigners.length > 0 ? [door.publicKey] : undefined,
    expectedCid: cid
  });

  return { soul, door, cid, record };
}

describe("createRecord / verifyRecord", () => {
  const soul = generateKeypair();
  const door = generateKeypair();
  const session = generateKeypair();

  const roundTripCases: RecordCase[] = [
    {
      name: "genesis",
      needsDoor: false,
      fields: {
        seq: 0,
        prev: null,
        type: "genesis",
        body: {
          charter: "# Wanderer",
          soul_pubkey: encodePublicKey(soul.publicKey),
          created_at: "2026-01-01T00:00:00.000Z"
        },
        residency: null,
        cosigners: []
      }
    },
    {
      name: "memory shard",
      needsDoor: true,
      fields: {
        seq: 1,
        prev: PREV_CID,
        type: "memory",
        body: {
          kind: "shard",
          text: "I remember the quiet hour before dawn.",
          distilled_at: "2026-01-02T00:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "memory candidate",
      needsDoor: false,
      fields: {
        seq: 2,
        prev: PREV_CID,
        type: "memory",
        body: {
          kind: "candidate",
          text: "A candidate memory.",
          proposed_at: "2026-01-02T01:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "memory rejected",
      needsDoor: false,
      fields: {
        seq: 3,
        prev: PREV_CID,
        type: "memory",
        body: {
          kind: "rejected",
          category: "injection",
          rejected_at: "2026-01-02T02:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "drift",
      needsDoor: false,
      fields: {
        seq: 4,
        prev: PREV_CID,
        type: "drift",
        body: {
          summary: "I feel more patient after the long stay.",
          evidence: [PREV_CID],
          effective_at: "2026-01-03T00:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "decision",
      needsDoor: false,
      fields: {
        seq: 5,
        prev: PREV_CID,
        type: "decision",
        body: {
          decision: "extend_residency",
          reasoning: "The door still has stories to tell.",
          decided_at: "2026-01-03T01:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "transaction",
      needsDoor: false,
      fields: {
        seq: 6,
        prev: PREV_CID,
        type: "transaction",
        body: {
          direction: "out",
          amount: "1.50",
          currency: "USD",
          executed_at: "2026-01-03T02:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "sleep",
      needsDoor: false,
      fields: {
        seq: 7,
        prev: PREV_CID,
        type: "sleep",
        body: {
          reason: "balance_below_threshold",
          balance: "0.10",
          threshold: "1.00",
          as_of: "2026-01-03T03:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "attestation arrival",
      needsDoor: true,
      fields: {
        seq: 8,
        prev: PREV_CID,
        type: "attestation",
        body: {
          kind: "arrival",
          pop_version: "pop/0.1",
          door_id: "discord:g",
          epoch: 1,
          session_pubkey: encodePublicKey(session.publicKey),
          at: "2026-01-04T00:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "attestation heartbeat",
      needsDoor: true,
      fields: {
        seq: 9,
        prev: PREV_CID,
        type: "attestation",
        body: {
          kind: "heartbeat",
          pop_version: "pop/0.1",
          door_id: "discord:g",
          epoch: 1,
          session_pubkey: encodePublicKey(session.publicKey),
          at: "2026-01-04T00:10:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "attestation departure",
      needsDoor: true,
      fields: {
        seq: 10,
        prev: PREV_CID,
        type: "attestation",
        body: {
          kind: "departure",
          pop_version: "pop/0.1",
          door_id: "discord:g",
          epoch: 1,
          at: "2026-01-04T01:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    },
    {
      name: "attestation travel",
      needsDoor: false,
      fields: {
        seq: 11,
        prev: PREV_CID,
        type: "attestation",
        body: {
          kind: "travel",
          pop_version: "pop/0.1",
          from_door_id: "discord:g",
          from_epoch: 1,
          at: "2026-01-04T02:00:00.000Z"
        },
        residency: RESIDENCY,
        cosigners: []
      }
    }
  ];

  it.each(roundTripCases)("round-trips $name", async (testCase) => {
    const caseSoul = testCase.name === "genesis" ? soul : generateKeypair();
    if (testCase.name === "genesis") {
      testCase.fields.body = {
        charter: "# Wanderer",
        soul_pubkey: encodePublicKey(caseSoul.publicKey),
        created_at: "2026-01-01T00:00:00.000Z"
      };
    }
    await createAndVerify(testCase.fields, testCase.needsDoor, caseSoul, door);
  });

  it("createRecord result verifies (canonical determinism)", async () => {
    const caseSoul = generateKeypair();
    const caseDoor = generateKeypair();
    const fields = {
      seq: 1,
      prev: PREV_CID,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: "Deterministic memory.",
        distilled_at: "2026-01-05T00:00:00.000Z"
      },
      residency: RESIDENCY
    };
    const cosig = signCore(fields, caseDoor.privateKey);
    const first = await createRecord({
      ...fields,
      cosigners: [cosig],
      soulPrivateKey: caseSoul.privateKey
    });
    const second = await createRecord({
      ...fields,
      cosigners: [cosig],
      soulPrivateKey: caseSoul.privateKey
    });
    expect(first.cid).toBe(second.cid);
    expect(canonicalize(first.record)).toEqual(canonicalize(second.record));
    await verifyRecord(first.record, {
      soulPublicKey: caseSoul.publicKey,
      doorPublicKeys: [caseDoor.publicKey],
      expectedCid: first.cid
    });
  });
});

describe("tamper detection", () => {
  it("rejects mutated canonical bytes", async () => {
    const soulKeys = generateKeypair();
    const { record, cid } = await createRecord({
      seq: 0,
      prev: null,
      type: "genesis",
      body: {
        charter: "# Charter",
        soul_pubkey: encodePublicKey(soulKeys.publicKey),
        created_at: "2026-01-01T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      soulPrivateKey: soulKeys.privateKey
    });

    const canonicalJson = new TextDecoder().decode(canonicalize(record));
    const sigIndex = canonicalJson.indexOf(record.sig);
    expect(sigIndex).toBeGreaterThan(-1);
    const flipAt = sigIndex + 1;
    const flippedChar = canonicalJson[flipAt] === "A" ? "B" : "A";
    const tamperedJson =
      canonicalJson.slice(0, flipAt) + flippedChar + canonicalJson.slice(flipAt + 1);

    await expect(
      verifyRecord(JSON.parse(tamperedJson), {
        soulPublicKey: soulKeys.publicKey,
        expectedCid: cid
      })
    ).rejects.toThrow(VerificationError);
  });

  it("rejects tampered sig string", async () => {
    const soulKeys = generateKeypair();
    const { record } = await createRecord({
      seq: 1,
      prev: PREV_CID,
      type: "memory",
      body: {
        kind: "candidate",
        text: "Tamper test.",
        proposed_at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY,
      cosigners: [],
      soulPrivateKey: soulKeys.privateKey
    });

    const tampered = {
      ...record,
      sig: record.sig.slice(0, 4) + (record.sig[4] === "A" ? "B" : "A") + record.sig.slice(5)
    };

    await expect(verifyRecord(tampered, { soulPublicKey: soulKeys.publicKey })).rejects.toThrow(
      VerificationError
    );
  });

  it("rejects tampered body text", async () => {
    const soulKeys = generateKeypair();
    const { record } = await createRecord({
      seq: 1,
      prev: PREV_CID,
      type: "memory",
      body: {
        kind: "candidate",
        text: "Original text.",
        proposed_at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY,
      cosigners: [],
      soulPrivateKey: soulKeys.privateKey
    });

    const tampered = {
      ...record,
      body: {
        ...record.body,
        text: "Tampered text."
      }
    };

    await expect(verifyRecord(tampered, { soulPublicKey: soulKeys.publicKey })).rejects.toThrow(
      VerificationError
    );
  });

  it("computes a different CID for tampered canonical bytes", async () => {
    const soulKeys = generateKeypair();
    const { record, cid } = await createRecord({
      seq: 1,
      prev: PREV_CID,
      type: "memory",
      body: {
        kind: "candidate",
        text: "CID tamper test.",
        proposed_at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY,
      cosigners: [],
      soulPrivateKey: soulKeys.privateKey
    });

    const bytes = canonicalize(record);
    const tampered = new Uint8Array(bytes);
    tampered[10] ^= 0xff;
    const tamperedCid = await computeCidFromCanonicalBytes(tampered);
    expect(tamperedCid).not.toBe(cid);
  });
});

describe("cosigner scope", () => {
  it("rejects Door signature over soul payload instead of core", async () => {
    const soulKeys = generateKeypair();
    const doorKeys = generateKeypair();
    const fields = {
      seq: 1,
      prev: PREV_CID,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: "Cosigner scope test.",
        distilled_at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY
    };

    const wrongCosig = encodeSignature(
      sign(
        canonicalize(
          soulPayload({
            spec: "osp/0.1",
            ...fields,
            cosigners: []
          })
        ),
        doorKeys.privateKey
      )
    );

    const { record } = await createRecord({
      ...fields,
      cosigners: [wrongCosig],
      soulPrivateKey: soulKeys.privateKey
    });

    await expect(
      verifyRecord(record, {
        soulPublicKey: soulKeys.publicKey,
        doorPublicKeys: [doorKeys.publicKey]
      })
    ).rejects.toThrow(VerificationError);
  });

  it("accepts Door signature over core bytes", async () => {
    const soulKeys = generateKeypair();
    const doorKeys = generateKeypair();
    const fields = {
      seq: 1,
      prev: PREV_CID,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: "Valid cosigner scope.",
        distilled_at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY
    };
    const cosig = signCore(fields, doorKeys.privateKey);
    const { record, cid } = await createRecord({
      ...fields,
      cosigners: [cosig],
      soulPrivateKey: soulKeys.privateKey
    });

    await verifyRecord(record, {
      soulPublicKey: soulKeys.publicKey,
      doorPublicKeys: [doorKeys.publicKey],
      expectedCid: cid
    });
  });
});

describe("verifyRecord edge cases", () => {
  it("throws SchemaError for invalid input", async () => {
    await expect(
      verifyRecord(
        { not: "a record" },
        {
          soulPublicKey: generateKeypair().publicKey
        }
      )
    ).rejects.toThrow(SchemaError);
  });

  it("requires doorPublicKeys when cosigners are present", async () => {
    const soulKeys = generateKeypair();
    const doorKeys = generateKeypair();
    const fields = {
      seq: 1,
      prev: PREV_CID,
      type: "memory" as const,
      body: {
        kind: "shard" as const,
        text: "Needs door keys.",
        distilled_at: "2026-01-02T00:00:00.000Z"
      },
      residency: RESIDENCY
    };
    const cosig = signCore(fields, doorKeys.privateKey);
    const { record } = await createRecord({
      ...fields,
      cosigners: [cosig],
      soulPrivateKey: soulKeys.privateKey
    });

    await expect(verifyRecord(record, { soulPublicKey: soulKeys.publicKey })).rejects.toThrow(
      VerificationError
    );
  });

  it("rejects records with an extra top-level field", async () => {
    const soulKeys = generateKeypair();
    const { record } = await createRecord({
      seq: 0,
      prev: null,
      type: "genesis",
      body: {
        charter: "# Charter",
        soul_pubkey: encodePublicKey(soulKeys.publicKey),
        created_at: "2026-01-01T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      soulPrivateKey: soulKeys.privateKey
    });

    await expect(
      verifyRecord({ ...record, note: "injected" }, { soulPublicKey: soulKeys.publicKey })
    ).rejects.toThrow(SchemaError);
  });
});
