import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Door,
  DoorError,
  HttpDoorServer,
  WsDoorSessionServer,
  type HostPolicy
} from "@npc/door-sdk";
import {
  OSP_SPEC_V02,
  createRecord,
  encodeBase64Url,
  encodePublicKey,
  FileSoulStore,
  verifyChain
} from "@npc/osp-core";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { FakeBrain } from "../src/brain/fake-brain.js";
import type { BrainMessage } from "../src/brain/types.js";
import { startResidencyDaemon } from "../src/daemon.js";
import { DISTILLER_SYSTEM } from "../src/prompts/distiller/system.js";
import { JOURNAL_SYSTEM } from "../src/prompts/journal/system.js";
import { loadReplicationConfig } from "../src/replication/config.js";
import { loadResidencyConfig } from "../src/residency/config.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import { FakeTimer } from "./helpers/fake-timer.js";

const DOOR_ID = "discord:rev";
const KEYS = { [DOOR_ID]: DOOR.publicKey };
const policy: HostPolicy = {
  community: { name: "x", description: "x", platform: "discord", invitation_required: false },
  capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "rev-"));
  const chainDir = join(root, "chain");
  const soulKeyPath = join(root, "soul.key");
  await writeFile(soulKeyPath, encodeBase64Url(SOUL.privateKey), "utf8");
  const store = await FileSoulStore.open(chainDir, { doorPublicKeys: KEYS });
  const g = await createRecord({
    spec: OSP_SPEC_V02,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# W",
      soul_pubkey: encodePublicKey(SOUL.publicKey),
      created_at: "2026-10-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: SOUL.privateKey
  });
  await store.append(g.record);
  await store.close();
  const door = new Door({
    doorId: DOOR_ID,
    doorKeypair: DOOR,
    soulPublicKey: SOUL.publicKey,
    clock: { now: () => new Date().toISOString() },
    policy
  });
  const http = new HttpDoorServer({ door });
  const info = await http.start();
  const ws = new WsDoorSessionServer({ door, server: http.nodeServer });
  await ws.start();
  const url = new URL(info.baseUrl);
  const config = {
    soulKeyPath,
    soulchainDir: chainDir,
    doorHttpHost: url.hostname,
    doorHttpPort: Number(url.port),
    doorId: DOOR_ID,
    doorPublicKeys: KEYS,
    brain: { apiKey: "t", model: "m", maxTokens: 1, timeoutMs: 1000 },
    readyFilePath: join(root, "ready"),
    replication: loadReplicationConfig({}),
    attentionMode: "always" as const,
    residency: {
      ...loadResidencyConfig({}),
      controlDir: join(root, "c"),
      journalDir: join(root, "j")
    }
  };
  return { door, http, ws, chainDir, config };
}
const brain = (n: number) =>
  new FakeBrain(async (m: BrainMessage[]) => {
    const s = m[0]?.content ?? "";
    if (s === DISTILLER_SYSTEM)
      return JSON.stringify({
        shards: Array.from({ length: n }, (_, i) => ({ text: `memory number ${i}` }))
      });
    if (s === JOURNAL_SYSTEM) return "# J";
    return "echo";
  });
async function waitFor(p: () => boolean) {
  const t = Date.now();
  while (!p()) {
    if (Date.now() - t > 8000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("residency lifecycle: abandon path", () => {
  it("departure attest keeps failing after candidates appended -> abandon -> arrival 2; chain verifies", async () => {
    const e = await setup();
    const orig = e.door.attest.bind(e.door);
    (e.door as unknown as { attest: typeof orig }).attest = async (req) => {
      if (req.kind === "departure") throw DoorError.fromCode("door_unavailable", "boom");
      return orig(req);
    };
    const b = brain(6);
    const h = await startResidencyDaemon(e.config, {
      brain: b,
      timer: new FakeTimer(),
      logger: pino({ level: "silent" }),
      skipSignals: true,
      sleep: async () => {}
    });
    await waitFor(() => e.ws.getActiveClients().size === 1);
    e.ws.broadcastInbound({ text: "hello there", author_id: "u" }, "m1");
    await waitFor(() => b.calls.length === 1);
    const out = await h.requestCycle("operator");
    expect(out.kind).toBe("abandoned");
    await h.shutdown();
    const store = await FileSoulStore.open(e.chainDir, { doorPublicKeys: KEYS });
    const v = await verifyChain(store, { doorPublicKeys: KEYS });
    const kinds: string[] = [];
    for await (const r of store.iterate())
      kinds.push(`${r.type}:${(r.body as { kind?: string }).kind ?? ""}:${r.residency ?? ""}`);
    // Abandoned residency: re-arrival at epoch 2 without departure records (rule 16 supersedes).
    expect(kinds.filter((k) => k.startsWith("attestation:arrival:")).length).toBe(2);
    expect(kinds.some((k) => k.startsWith("attestation:departure"))).toBe(false);
    await store.close();
    expect(v.valid).toBe(true);
    await e.ws.stop();
    await e.http.stop();
  });
  it("too few shards (operator trigger, short transcript) -> abandon", async () => {
    const e = await setup();
    const b = brain(3);
    const h = await startResidencyDaemon(e.config, {
      brain: b,
      timer: new FakeTimer(),
      logger: pino({ level: "silent" }),
      skipSignals: true,
      sleep: async () => {}
    });
    await waitFor(() => e.ws.getActiveClients().size === 1);
    e.ws.broadcastInbound({ text: "hello there", author_id: "u" }, "m1");
    await waitFor(() => b.calls.length === 1);
    const out = await h.requestCycle("operator");
    expect(out.kind).toBe("abandoned");
    await h.shutdown();
    const store = await FileSoulStore.open(e.chainDir, { doorPublicKeys: KEYS });
    const v = await verifyChain(store, { doorPublicKeys: KEYS });
    expect(v.valid).toBe(true);
    await store.close();
    await e.ws.stop();
    await e.http.stop();
  });
});
