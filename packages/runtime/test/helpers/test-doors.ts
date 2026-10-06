import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Door,
  HttpDoorServer,
  WsDoorSessionServer,
  type Capability,
  type HostPolicy
} from "@npc/door-sdk";
import {
  OSP_SPEC_V02,
  createRecord,
  encodeBase64Url,
  encodePublicKey,
  FileSoulStore,
  verifyChain,
  type Ed25519Keypair,
  type OspRecord
} from "@npc/osp-core";
import pino, { type Logger } from "pino";
import { expect } from "vitest";

import type { DaemonConfig } from "../../src/daemon-config.js";
import { loadReplicationConfig } from "../../src/replication/config.js";
import { loadResidencyConfig, type ResidencyConfig } from "../../src/residency/config.js";
import { ScriptedWitness } from "./door-stub.js";
import { SOUL } from "./fixed-keys.js";

/** Wall clock with a test-controlled offset, shared by Doors and the daemon. */
export class OffsetClock {
  offsetMs = 0;
  now(): string {
    return new Date(Date.now() + this.offsetMs).toISOString();
  }
}

/** A real door-sdk Door served over HTTP + WebSocket on an ephemeral port. */
export type TestDoor = {
  doorId: string;
  door: Door;
  witness: ScriptedWitness | null;
  httpServer: HttpDoorServer;
  wsServer: WsDoorSessionServer;
  baseUrl: string;
  /** Toggle `hello` availability (`door_unavailable` while false). */
  available: boolean;
  stop: () => Promise<void>;
};

/**
 * Start a Door. `witness` defaults to a {@link ScriptedWitness} that witnesses everything;
 * `null` = no `attest.memory`.
 */
export async function startTestDoor(options: {
  doorId: string;
  keypair: Ed25519Keypair;
  witness?: ScriptedWitness | null;
  clock?: { now(): string };
  capabilities?: Capability[];
}): Promise<TestDoor> {
  const witness = options.witness === undefined ? new ScriptedWitness() : options.witness;
  const handle = { available: true };
  const policy: HostPolicy = {
    community: {
      name: options.doorId,
      description: "Multi-Door residency tests.",
      platform: "test",
      invitation_required: false
    },
    capabilities: options.capabilities ?? ["session.text", "heartbeat", "attest"],
    isAvailable: () => handle.available,
    ...(witness === null ? {} : { witnessMemory: witness.witness })
  };
  const door = new Door({
    doorId: options.doorId,
    doorKeypair: options.keypair,
    soulPublicKey: SOUL.publicKey,
    clock: options.clock ?? { now: () => new Date().toISOString() },
    policy
  });
  const httpServer = new HttpDoorServer({ door });
  const { baseUrl } = await httpServer.start();
  const wsServer = new WsDoorSessionServer({ door, server: httpServer.nodeServer });
  await wsServer.start();
  const testDoor: TestDoor = {
    doorId: options.doorId,
    door,
    witness,
    httpServer,
    wsServer,
    baseUrl,
    get available() {
      return handle.available;
    },
    set available(value: boolean) {
      handle.available = value;
    },
    stop: async () => {
      await wsServer.stop();
      await httpServer.stop();
    }
  };
  return testDoor;
}

/** A soulchain dir with a genesis record, plus the soul key file and work dirs. */
export async function createSoulDirs(prefix: string): Promise<{
  root: string;
  chainDir: string;
  soulKeyPath: string;
  controlDir: string;
  journalDir: string;
  readyFilePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const chainDir = join(root, "chain");
  const soulKeyPath = join(root, "soul.key");
  await writeFile(soulKeyPath, encodeBase64Url(SOUL.privateKey), "utf8");
  const store = await FileSoulStore.open(chainDir, { doorPublicKeys: {} });
  const genesis = await createRecord({
    spec: OSP_SPEC_V02,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nMulti-Door residency test.",
      soul_pubkey: encodePublicKey(SOUL.publicKey),
      created_at: "2026-10-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: SOUL.privateKey
  });
  await store.append(genesis.record);
  await store.close();
  return {
    root,
    chainDir,
    soulKeyPath,
    controlDir: join(root, "control"),
    journalDir: join(root, "published", "journals"),
    readyFilePath: join(root, "ready")
  };
}

/** Daemon config for `doors` (trusted keys from `doorPublicKeys`). */
export function multiDoorConfig(options: {
  dirs: Awaited<ReturnType<typeof createSoulDirs>>;
  doors: readonly TestDoor[];
  doorPublicKeys: Readonly<Record<string, Uint8Array>>;
  preferredDoorId?: string;
  residency?: Partial<ResidencyConfig>;
  attentionMode?: DaemonConfig["attentionMode"];
}): DaemonConfig {
  const { dirs } = options;
  return {
    soulKeyPath: dirs.soulKeyPath,
    soulchainDir: dirs.chainDir,
    doorUrls: options.doors.map((door) => door.baseUrl),
    ...(options.preferredDoorId === undefined ? {} : { preferredDoorId: options.preferredDoorId }),
    doorPublicKeys: { ...options.doorPublicKeys } as DaemonConfig["doorPublicKeys"],
    brain: {
      provider: "anthropic",
      apiKey: "test",
      model: "test-model",
      maxTokens: 1024,
      timeoutMs: 60_000
    },
    readyFilePath: dirs.readyFilePath,
    replication: loadReplicationConfig({}),
    attentionMode: options.attentionMode ?? "always",
    residency: {
      ...loadResidencyConfig({ NPC_RESIDENCY_MAX_MS: "0" }),
      controlDir: dirs.controlDir,
      journalDir: dirs.journalDir,
      ...options.residency
    }
  };
}

/** Read the chain and assert it verifies under `doorPublicKeys`. */
export async function readVerifiedChain(
  chainDir: string,
  doorPublicKeys: Readonly<Record<string, Uint8Array>>
): Promise<OspRecord[]> {
  const store = await FileSoulStore.open(chainDir, { doorPublicKeys });
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  const verified = await verifyChain(store, { doorPublicKeys });
  expect(verified.valid).toBe(true);
  await store.close();
  return records;
}

/** `type/kind[:detail]` per record after genesis. */
export function chainShape(records: readonly OspRecord[]): string[] {
  return records.slice(1).map((record) => {
    if (record.type === "memory") {
      return record.body.kind === "rejected"
        ? `memory/rejected:${record.body.category}`
        : `memory/${record.body.kind}`;
    }
    if (record.type === "attestation") {
      const body = record.body;
      switch (body.kind) {
        case "arrival":
          return `arrival:${body.door_id}:${String(body.epoch)}`;
        case "departure":
          return `departure:${body.door_id}:${String(body.epoch)}`;
        case "travel":
          return `travel:${body.from_door_id}->${body.to_door_id ?? "?"}`;
        default:
          return body.kind;
      }
    }
    return record.type;
  });
}

/** pino logger capturing JSON lines (`msg` + fields) for assertions. */
export function capturingLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "info" },
    {
      write: (chunk: string) => {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      }
    }
  );
  return { logger, lines };
}

/** Poll until `predicate` holds (8 s timeout). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > 8_000) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
