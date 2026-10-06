/**
 * Abandon path through the real daemon: the departing Door's witness stays unavailable,
 * every depart attempt fails, and the controller falls back to `departBare` (departure +
 * travel, no memories) before arriving at the next Door.
 */
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import type { BrainMessage } from "../src/brain/types.js";
import { startResidencyDaemon, type ResidencyDaemonHandle } from "../src/daemon.js";
import { DISTILLER_SYSTEM } from "../src/prompts/distiller/system.js";
import { ScriptedWitness } from "./helpers/door-stub.js";
import { FakeTimer } from "./helpers/fake-timer.js";
import { DOOR, OTHER_DOOR } from "./helpers/fixed-keys.js";
import {
  chainShape,
  createSoulDirs,
  multiDoorConfig,
  readVerifiedChain,
  startTestDoor,
  waitFor,
  type TestDoor
} from "./helpers/test-doors.js";

const A = "discord:a";
const B = "web:b";
const KEYS = { [A]: DOOR.publicKey, [B]: OTHER_DOOR.publicKey };
const SHARD = "I remember a long night of questions.";

describe("residency lifecycle: abandon path", () => {
  const doors: TestDoor[] = [];
  let handle: ResidencyDaemonHandle | null = null;

  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
    for (const door of doors.splice(0)) {
      await door.stop();
    }
  });

  it("witness_unavailable on every attempt → abandoned → departBare → arrival at B; chain verifies", async () => {
    const dirs = await createSoulDirs("npc-abandon-");
    const witness = new ScriptedWitness(() => "unavailable");
    const a = await startTestDoor({ doorId: A, keypair: DOOR, witness });
    const b = await startTestDoor({ doorId: B, keypair: OTHER_DOOR });
    doors.push(a, b);
    let distills = 0;
    const brain = new FakeBrain((messages: BrainMessage[]) => {
      if (messages[0]?.content === DISTILLER_SYSTEM) {
        distills += 1;
        return JSON.stringify({ shards: [{ text: SHARD }] });
      }
      return "echo";
    });

    handle = await startResidencyDaemon(
      multiDoorConfig({ dirs, doors: [a, b], doorPublicKeys: KEYS, preferredDoorId: A }),
      {
        brain,
        timer: new FakeTimer(),
        logger: pino({ level: "silent" }),
        skipSignals: true,
        departRetryDelaysMs: [1, 1]
      }
    );
    await waitFor(() => a.wsServer.getActiveClients().size === 1, "socket at A");
    a.wsServer.broadcastInbound({ text: "are you staying?", author_id: "u1" }, "in-1");
    await waitFor(() => brain.calls.length === 1, "reply");

    const outcome = await handle.requestCycle("operator");

    expect(outcome).toMatchObject({
      kind: "abandoned",
      fromDoor: A,
      toDoor: B,
      fromEpoch: 1,
      toEpoch: 2
    });
    expect(witness.texts("shard")).toEqual([SHARD, SHARD, SHARD]);
    expect(distills).toBe(1);
    await handle.shutdown();
    handle = null;

    expect(chainShape(await readVerifiedChain(dirs.chainDir, KEYS))).toEqual([
      `arrival:${A}:1`,
      `departure:${A}:1`,
      `travel:${A}->${B}`,
      `arrival:${B}:2`
    ]);
    // A closed the epoch at departure.
    expect(a.door.getActiveEpoch()).toBeNull();
  });
});
