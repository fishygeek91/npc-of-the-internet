#!/usr/bin/env node
/**
 * Offline first-residency harness for the T6.2 launch dry-run.
 *
 * Proves arrival, heartbeat, and inbound→outbound exchange against an
 * already-initialized soulchain directory (from `osp init`). Uses FakeBrain
 * only — no network, no live model calls.
 *
 * Required env:
 *   CHAIN_DIR — absolute path to soulchain with genesis + soul.key
 *
 * Optional env:
 *   DOOR_ID — residency door identifier (default: discord:launch-dry-run)
 *   READY_FILE — unused in Session path; reserved for daemon parity (default: $CHAIN_DIR/ready)
 *
 * On success prints parseable stdout:
 *   DOOR_PUBLIC_KEY=<base64url>
 *   DOOR_ID=<id>
 *   RESIDENCY_OK=1
 */

import { access, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

const DEFAULT_DOOR_ID = "discord:launch-dry-run";
const CLOCK_ISO = "2026-07-21T12:00:00.000Z";
const HEARTBEAT_INTERVAL_MS = 100;
const REPLY_TEXT = "I arrived through the dry-run harness and heard you.";

/**
 * Injectable timer matching runtime `Timer`. `tick()` invokes every active
 * interval handler once without real sleeps (same contract as test FakeTimer).
 */
class FakeTimer {
  constructor() {
    /** @type {Map<number, { handler: () => void; cleared: boolean }>} */
    this.intervals = new Map();
    this.nextId = 1;
  }

  /**
   * @param {() => void} handler
   * @param {number} _ms — interval length ignored; {@link FakeTimer.tick} advances time
   * @returns {number}
   */
  setInterval(handler, _ms) {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.set(id, { handler, cleared: false });
    return id;
  }

  /**
   * @param {unknown} id
   */
  clearInterval(id) {
    if (typeof id !== "number") {
      return;
    }
    const entry = this.intervals.get(id);
    if (entry !== undefined) {
      entry.cleared = true;
    }
  }

  /** Simulate one heartbeat interval elapsing for every active timer. */
  tick() {
    for (const entry of this.intervals.values()) {
      if (!entry.cleared) {
        entry.handler();
      }
    }
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  process.stderr.write(`[launch-first-residency] ERROR: ${message}\n`);
  process.exit(1);
}

/**
 * Dynamic import of a built workspace package dist entry.
 *
 * @param {string} relativeDistPath — path under repo root, e.g. packages/runtime/dist/index.js
 */
async function importDist(relativeDistPath) {
  const href = pathToFileURL(join(REPO_ROOT, relativeDistPath)).href;
  return import(href);
}

/**
 * @param {string} path
 * @param {string} label
 */
async function requirePath(path, label) {
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    die(`${label} not readable at ${path}`);
  }
}

/**
 * Collect all OSP records from a soul store iterator.
 *
 * @param {import("@npc/osp-core").SoulStore} store
 */
async function collectRecords(store) {
  /** @type {import("@npc/osp-core").OspRecord[]} */
  const records = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }
  return records;
}

/**
 * @param {import("@npc/osp-core").OspRecord[]} records
 * @param {string} kind
 */
function countAttestations(records, kind) {
  return records.filter(
    (record) => record.type === "attestation" && record.body.kind === kind
  ).length;
}

async function main() {
  const chainDirRaw = process.env.CHAIN_DIR;
  if (chainDirRaw === undefined || chainDirRaw.trim() === "") {
    die("CHAIN_DIR is required (absolute path to initialized soulchain)");
  }

  if (!isAbsolute(chainDirRaw)) {
    die("CHAIN_DIR must be an absolute path");
  }
  const chainDir = resolve(chainDirRaw);

  const doorId =
    process.env.DOOR_ID === undefined || process.env.DOOR_ID === ""
      ? DEFAULT_DOOR_ID
      : process.env.DOOR_ID;

  const soulKeyPath = join(chainDir, "soul.key");
  const chainJsonlPath = join(chainDir, "chain.jsonl");
  await requirePath(soulKeyPath, "soul.key");
  await requirePath(chainJsonlPath, "chain.jsonl");

  const { encodeBase64Url, encodePublicKey, FileSoulStore } = await importDist(
    "packages/osp-core/dist/index.js"
  );
  const { Door, generateDoorKeypair, InProcessDoorConnection } = await importDist(
    "packages/door-sdk/dist/index.js"
  );
  const { FakeBrain, loadSoulPrivateKeyFromPath, Session, SingleKeyKeyring } =
    await importDist("packages/runtime/dist/index.js");

  const soulPrivateKey = loadSoulPrivateKeyFromPath(soulKeyPath);
  const keyring = new SingleKeyKeyring(soulPrivateKey);
  const soulPublicKey = keyring.getSoulPublicKey();
  const soulPublicKeyEncoded = encodePublicKey(soulPublicKey);

  const doorKeypair = generateDoorKeypair();
  const doorPublicKey = doorKeypair.publicKey;
  const doorPublicKeyEncoded = encodePublicKey(doorPublicKey);
  const doorKeyPath = join(chainDir, "door.key");

  writeFileSync(doorKeyPath, encodeBase64Url(doorKeypair.privateKey), { mode: 0o600 });

  /** @type {import("@npc/door-sdk").HostPolicy} */
  const hostPolicy = {
    community: {
      name: "Launch Dry-Run",
      description: "Offline T6.2 residency harness (FakeBrain, no network).",
      platform: "test",
      invitation_required: false
    },
    capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"]
  };

  const clock = { now: () => CLOCK_ISO };
  const doorCore = new Door({
    doorId,
    doorKeypair,
    soulPublicKey,
    clock,
    policy: hostPolicy
  });
  const door = new InProcessDoorConnection(doorCore);

  const store = await FileSoulStore.open(chainDir, {
    doorPublicKeys: [doorPublicKey]
  });

  const timer = new FakeTimer();
  const brain = new FakeBrain([REPLY_TEXT]);

  let session;
  try {
    session = await Session.start({
      store,
      brain,
      door,
      keyring,
      doorId,
      timer,
      clock,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      doorPublicKeys: [doorPublicKey]
    });

    let records = await collectRecords(store);
    if (countAttestations(records, "arrival") < 1) {
      die("expected at least one arrival attestation after Session.start");
    }

    const inbound = {
      type: "inbound",
      door_id: doorId,
      epoch: session.epoch,
      msg_id: "in-dry-run-1",
      issued_at: clock.now(),
      body: {
        text: "Hello from the launch dry-run guild.",
        author_id: "user-dry-run"
      }
    };

    const inboundResult = await session.handleInbound(inbound);
    if (!inboundResult.ok) {
      die("handleInbound failed (screened or brain error)");
    }
    if (inboundResult.outbound.body.text !== REPLY_TEXT) {
      die("outbound text does not match FakeBrain scripted reply");
    }
    if (!door.verifyOutbound(inboundResult.outbound)) {
      die("door rejected outbound frame signature");
    }

    timer.tick();
    timer.tick();
    await session.drainAppends();

    records = await collectRecords(store);
    if (countAttestations(records, "heartbeat") < 1) {
      die("expected at least one heartbeat attestation after timer ticks");
    }

    const doorPubkeyPath = join(chainDir, "door.pubkey");
    await writeFile(doorPubkeyPath, `${doorPublicKeyEncoded}\n`, "utf8");

    const metaPath = join(chainDir, "dry-run-meta.json");
    const meta = {
      doorPublicKey: doorPublicKeyEncoded,
      doorId,
      soulPublicKey: soulPublicKeyEncoded
    };
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    session.stop();
    await session.drainAppends();
  } finally {
    if (session !== undefined) {
      session.stop();
    }
    await store.close();
  }

  process.stdout.write(`DOOR_PUBLIC_KEY=${doorPublicKeyEncoded}\n`);
  process.stdout.write(`DOOR_ID=${doorId}\n`);
  process.stdout.write("RESIDENCY_OK=1\n");
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  die(detail);
});
