import { describe, expect, it } from "vitest";

import { encodePublicKey, encodeSignature } from "../src/encoding/base64url.js";
import { RecordSchema } from "../src/schemas/index.js";

/** Deterministic 32-byte test public keys (distinct fill bytes). */
const TEST_SOUL_PUBKEY = encodePublicKey(new Uint8Array(32).fill(1));
const TEST_SESSION_PUBKEY = encodePublicKey(new Uint8Array(32).fill(2));

/** Deterministic 64-byte test signatures (distinct fill bytes). */
const TEST_SOUL_SIG = encodeSignature(new Uint8Array(64).fill(3));
const TEST_DOOR_COSIG = encodeSignature(new Uint8Array(64).fill(4));

const PREV_CID = "bagu" + "a".repeat(57);
const RESIDENCY = "door:discord:guild123/epoch:1";

const VALID_GENESIS = {
  spec: "osp/0.1",
  seq: 0,
  prev: null,
  type: "genesis" as const,
  body: {
    charter: "# Wanderer charter",
    soul_pubkey: TEST_SOUL_PUBKEY,
    created_at: "2026-01-01T00:00:00.000Z"
  },
  residency: null,
  cosigners: [] as string[],
  sig: TEST_SOUL_SIG
};

const VALID_CANDIDATE = {
  spec: "osp/0.1",
  seq: 1,
  prev: PREV_CID,
  type: "memory" as const,
  body: {
    kind: "candidate" as const,
    text: "I remember the quiet hour before dawn.",
    proposed_at: "2026-01-02T00:00:00.000Z"
  },
  residency: RESIDENCY,
  cosigners: [] as string[],
  sig: TEST_SOUL_SIG
};

const VALID_SHARD = {
  ...VALID_CANDIDATE,
  seq: 2,
  body: {
    kind: "shard" as const,
    text: "I remember the quiet hour before dawn.",
    distilled_at: "2026-01-03T00:00:00.000Z"
  },
  cosigners: [TEST_DOOR_COSIG]
};

const VALID_ARRIVAL = {
  spec: "osp/0.1",
  seq: 1,
  prev: PREV_CID,
  type: "attestation" as const,
  body: {
    kind: "arrival" as const,
    pop_version: "pop/0.1" as const,
    door_id: "discord:guild123",
    epoch: 1,
    session_pubkey: TEST_SESSION_PUBKEY,
    at: "2026-01-01T00:00:00.000Z"
  },
  residency: RESIDENCY,
  cosigners: [TEST_DOOR_COSIG],
  sig: TEST_SOUL_SIG
};

describe("RecordSchema", () => {
  it("accepts genesis at seq 0 with null prev and residency", () => {
    const result = RecordSchema.safeParse(VALID_GENESIS);
    expect(result.success).toBe(true);
  });

  it("rejects seq > 0 with null prev", () => {
    const result = RecordSchema.safeParse({
      ...VALID_CANDIDATE,
      prev: null
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("prev");
    }
  });

  it("rejects shard text longer than 500 Unicode code points", () => {
    const result = RecordSchema.safeParse({
      ...VALID_SHARD,
      body: {
        ...VALID_SHARD.body,
        text: "a".repeat(501)
      }
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => message.includes("500 Unicode code points"))).toBe(true);
    }
  });

  it("rejects rejected memory body with extra text field (.strict)", () => {
    const result = RecordSchema.safeParse({
      ...VALID_CANDIDATE,
      seq: 3,
      body: {
        kind: "rejected",
        category: "injection",
        rejected_at: "2026-01-04T00:00:00.000Z",
        text: "must not appear"
      }
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects shard memory with empty cosigners", () => {
    const result = RecordSchema.safeParse({
      ...VALID_SHARD,
      cosigners: []
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => message.includes("cosigner"))).toBe(true);
    }
  });

  it("rejects arrival attestation with empty cosigners", () => {
    const result = RecordSchema.safeParse({
      ...VALID_ARRIVAL,
      cosigners: []
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => message.includes("cosigner"))).toBe(true);
    }
  });

  it("accepts valid candidate with empty cosigners", () => {
    const result = RecordSchema.safeParse(VALID_CANDIDATE);
    expect(result.success).toBe(true);
  });

  it("rejects genesis with non-empty cosigners", () => {
    const result = RecordSchema.safeParse({
      ...VALID_GENESIS,
      cosigners: [TEST_DOOR_COSIG]
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => message.includes("genesis"))).toBe(true);
    }
  });

  it("rejects invalid residency format", () => {
    const result = RecordSchema.safeParse({
      ...VALID_CANDIDATE,
      residency: "discord:guild123/epoch:1"
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("residency");
    }
  });

  it("accepts residency matching door:discord:guild123/epoch:77", () => {
    const result = RecordSchema.safeParse({
      ...VALID_CANDIDATE,
      residency: "door:discord:guild123/epoch:77"
    });
    expect(result.success).toBe(true);
  });

  it("rejects attestation door_id mismatch with residency", () => {
    const result = RecordSchema.safeParse({
      ...VALID_ARRIVAL,
      body: {
        ...VALID_ARRIVAL.body,
        door_id: "discord:wrong"
      }
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("body.door_id");
    }
  });

  it("rejects invalid soul_pubkey length", () => {
    const result = RecordSchema.safeParse({
      ...VALID_GENESIS,
      body: {
        ...VALID_GENESIS.body,
        soul_pubkey: "too-short"
      }
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("body.soul_pubkey");
    }
  });

  it("rejects invalid session_pubkey length", () => {
    const result = RecordSchema.safeParse({
      ...VALID_ARRIVAL,
      body: {
        ...VALID_ARRIVAL.body,
        session_pubkey: "too-short"
      }
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("body.session_pubkey");
    }
  });

  it("rejects invalid sig length", () => {
    const result = RecordSchema.safeParse({
      ...VALID_GENESIS,
      sig: "too-short"
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("sig");
    }
  });

  it("rejects invalid cosigner signature length", () => {
    const result = RecordSchema.safeParse({
      ...VALID_SHARD,
      cosigners: ["too-short"]
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths.some((path) => path.startsWith("cosigners"))).toBe(true);
    }
  });
});
