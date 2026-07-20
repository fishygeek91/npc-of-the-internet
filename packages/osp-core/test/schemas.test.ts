import { describe, expect, it } from "vitest";

import { RecordSchema } from "../src/schemas/index.js";

const VALID_GENESIS = {
  spec: "osp/0.1",
  seq: 0,
  prev: null,
  type: "genesis" as const,
  body: {
    charter: "# Wanderer charter",
    soul_pubkey: "soul-pubkey-base64url",
    created_at: "2026-01-01T00:00:00.000Z"
  },
  residency: null,
  cosigners: [] as string[],
  sig: "soul-sig-base64url"
};

const VALID_CANDIDATE = {
  spec: "osp/0.1",
  seq: 1,
  prev: "bafybeigdyrzt5sfp7udm7nmwgynf5dpdqnm",
  type: "memory" as const,
  body: {
    kind: "candidate" as const,
    text: "I remember the quiet hour before dawn.",
    proposed_at: "2026-01-02T00:00:00.000Z"
  },
  residency: "door:discord:guild123/epoch:1",
  cosigners: [] as string[],
  sig: "soul-sig-base64url"
};

const VALID_SHARD = {
  ...VALID_CANDIDATE,
  seq: 2,
  body: {
    kind: "shard" as const,
    text: "I remember the quiet hour before dawn.",
    distilled_at: "2026-01-03T00:00:00.000Z"
  },
  cosigners: ["door-cosig-base64url"]
};

const VALID_ARRIVAL = {
  spec: "osp/0.1",
  seq: 1,
  prev: "bafybeigdyrzt5sfp7udm7nmwgynf5dpdqnm",
  type: "attestation" as const,
  body: {
    kind: "arrival" as const,
    pop_version: "pop/0.1" as const,
    door_id: "discord:guild123",
    epoch: 1,
    session_pubkey: "session-pubkey-base64url",
    at: "2026-01-01T00:00:00.000Z"
  },
  residency: "door:discord:guild123/epoch:1",
  cosigners: ["door-cosig-base64url"],
  sig: "soul-sig-base64url"
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
});
