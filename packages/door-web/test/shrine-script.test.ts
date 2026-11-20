import { encodePublicKey, generateKeypair } from "@npc/osp-core";
import { ChainVerifier } from "@npc/osp-core/browser";
import { afterEach, describe, expect, it } from "vitest";

import {
  feedVerifier,
  rememberPageScript,
  type VerifyWorker
} from "../src/browser/incremental-chain.js";
import { loadShrine } from "../src/browser/shrine-chain.js";
import { Room } from "../src/room.js";
import { VisitorSite } from "../src/site.js";
import { silentLogger } from "./helpers.js";
import { bareHooks, DOOR_ID, pins, stay } from "./shrine-fixture.js";

describe("shrine.js can be read by an embed", () => {
  const sites: VisitorSite[] = [];

  afterEach(async () => {
    for (const site of sites.splice(0)) {
      await site.stop();
    }
  });

  it("sends Access-Control-Allow-Origin on /shrine.js and the page loads that script", async () => {
    const site = new VisitorSite({
      door: { id: DOOR_ID, name: "Test porch", description: "For tests." },
      room: new Room(),
      isPresent: () => false,
      lastSeenHere: () => null,
      relay: () => false,
      maxClients: 4,
      globalPerMinute: 10,
      dailyMax: 10,
      trustProxy: false,
      clock: { nowMs: () => 0 },
      logger: silentLogger,
      verifyPins: { soulPublicKey: "soul", doorPublicKey: "door", atlasUrl: null }
    });
    sites.push(site);
    const bound = await site.start("127.0.0.1", 0);
    const shrineUrl = `${bound.url}/shrine.js`;
    const shrine = await fetch(shrineUrl);
    expect(shrine.status).toBe(200);
    expect(shrine.headers.get("access-control-allow-origin")).toBe("*");
    expect(shrine.headers.get("access-control-allow-credentials")).toBeNull();
    const verify = await fetch(`${bound.url}/verify.js`);
    const app = await fetch(`${bound.url}/app.js`);
    expect(verify.headers.get("access-control-allow-origin")).toBeNull();
    expect(app.headers.get("access-control-allow-origin")).toBeNull();

    const soul = generateKeypair();
    const door = generateKeypair();
    const built = await stay(soul, door);
    let illegal = 0;
    let scriptFetches = 0;
    let runs = 0;
    let blobSize = 0;
    rememberPageScript({ document: { currentScript: { src: shrineUrl } } });
    const worker: VerifyWorker = {
      async run(request) {
        if (this !== worker) {
          illegal += 1;
          throw new TypeError("Illegal invocation");
        }
        runs += 1;
        const fed = await feedVerifier(
          new ChainVerifier({ doorPublicKeys: request.doorPublicKeys }),
          request.records,
          null
        );
        return { id: request.id, ok: fed.ok, fed: fed.fed, head: fed.ok ? fed.head : null };
      },
      terminate() {
        if (this !== worker) {
          illegal += 1;
          throw new TypeError("Illegal invocation");
        }
      }
    };
    const hooks = bareHooks(
      {
        fetch(url: string, init?: RequestInit): Promise<Response> {
          if (url === shrineUrl) {
            scriptFetches += 1;
            expect(init?.cache).toBe("force-cache");
            return fetch(url, init);
          }
          if (url === `${bound.url}/chain/export`) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  records: built.records,
                  doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
                  blobs: built.blobs
                }),
                { status: 200, headers: { "content-type": "application/json" } }
              )
            );
          }
          return Promise.reject(new Error(`unexpected fetch ${url}`));
        },
        createObjectURL(blob: Blob): string {
          blobSize = blob.size;
          return "blob:shrine-test";
        },
        revokeObjectURL(): void {
          return;
        },
        createWorker(): VerifyWorker {
          return worker;
        }
      },
      () => {
        illegal += 1;
      }
    );
    if (hooks.fetch === undefined) {
      throw new Error("missing fetch");
    }
    const loaded = await loadShrine(pins(bound.url, soul), null, hooks.fetch, hooks);
    expect(scriptFetches).toBe(1);
    expect(blobSize).toBeGreaterThan(100_000);
    expect(runs).toBe(1);
    expect(loaded.snapshot.badge).toBe("PRESENT");
    expect(illegal).toBe(0);
  });
});
