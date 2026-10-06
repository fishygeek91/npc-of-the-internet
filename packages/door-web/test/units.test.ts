import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeBase64Url, encodePublicKey, generateKeypair } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { AtlasWhereabouts } from "../src/atlas.js";
import { loadWebDoorConfig } from "../src/config.js";
import { WebDoorError } from "../src/errors.js";
import { loadDoorKeypairFromPath } from "../src/load-door-key.js";
import { DailyBudget, VisitorRateLimiter } from "../src/rate-limit.js";
import { Room, ROOM_CAPACITY } from "../src/room.js";
import {
  clientIp,
  clientKey,
  foldName,
  isAddressed,
  parseSay,
  relayText,
  VisitorIds
} from "../src/visitor.js";

const SOUL = generateKeypair();

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DOOR_KEY_PATH: "/keys/door.key",
    SOUL_PUBLIC_KEY: encodePublicKey(SOUL.publicKey),
    ...extra
  };
}

describe("loadWebDoorConfig", () => {
  it("applies defaults", () => {
    const config = loadWebDoorConfig(env());
    expect(config).toMatchObject({
      doorId: "web:home",
      doorHttpHost: "0.0.0.0",
      doorHttpPort: 9091,
      publicHost: "0.0.0.0",
      publicPort: 8080,
      communityName: "The Wanderer's front porch",
      maxClients: 200,
      globalPerMinute: 30,
      dailyMax: 1500,
      trustProxy: false
    });
    expect(config.atlasApiUrl).toBeUndefined();
  });

  it("reads overrides", () => {
    const config = loadWebDoorConfig(
      env({
        DOOR_WEB_ID: "web:porch",
        DOOR_HTTP_PORT: "7000",
        DOOR_WEB_PUBLIC_PORT: "8081",
        DOOR_WEB_MAX_CLIENTS: "5",
        DOOR_WEB_GLOBAL_PER_MIN: "9",
        DOOR_WEB_DAILY_MAX: "40",
        DOOR_WEB_TRUST_PROXY: "1",
        DOOR_WEB_COMMUNITY_NAME: "Porch",
        ATLAS_API_URL: "http://atlas-api:8090/"
      })
    );
    expect(config).toMatchObject({
      doorId: "web:porch",
      doorHttpPort: 7000,
      publicPort: 8081,
      maxClients: 5,
      globalPerMinute: 9,
      dailyMax: 40,
      trustProxy: true,
      communityName: "Porch",
      atlasApiUrl: "http://atlas-api:8090"
    });
  });

  it.each([
    [{ DOOR_KEY_PATH: "" }, "DOOR_KEY_PATH"],
    [{ SOUL_PUBLIC_KEY: "nope" }, "SOUL_PUBLIC_KEY"],
    [{ DOOR_WEB_ID: "discord:1" }, "DOOR_WEB_ID"],
    [{ DOOR_WEB_ID: "web:" }, "DOOR_WEB_ID"],
    [{ DOOR_WEB_MAX_CLIENTS: "0" }, "DOOR_WEB_MAX_CLIENTS"],
    [{ DOOR_WEB_DAILY_MAX: "-1" }, "DOOR_WEB_DAILY_MAX"],
    [{ DOOR_HTTP_PORT: "12.5" }, "DOOR_HTTP_PORT"],
    [{ ATLAS_API_URL: "file:///etc/passwd" }, "ATLAS_API_URL"]
  ])("rejects %j", (extra, name) => {
    expect(() => loadWebDoorConfig(env(extra))).toThrow(WebDoorError);
    expect(() => loadWebDoorConfig(env(extra))).toThrow(name);
  });

  it("trusts the proxy only for exactly 1", () => {
    expect(loadWebDoorConfig(env({ DOOR_WEB_TRUST_PROXY: "true" })).trustProxy).toBe(false);
  });
});

describe("VisitorRateLimiter", () => {
  it("allows 1 per 3 s and 20 per 10 min per visitor", () => {
    let now = 0;
    const limiter = new VisitorRateLimiter({ globalPerMinute: 1000, clock: { nowMs: () => now } });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterMs: 3000 });
    expect(limiter.take("b").ok).toBe(true);
    now += 3000;
    expect(limiter.take("a").ok).toBe(true);
    for (let sent = 2; sent < 20; sent += 1) {
      now += 3000;
      expect(limiter.take("a").ok).toBe(true);
    }
    now += 3000;
    const blocked = limiter.take("a");
    expect(blocked.ok).toBe(false);
    // The first message (t=0) leaves the 10-minute window at t=600 000.
    expect(blocked.ok === false && blocked.retryAfterMs).toBe(600_000 - now);
    now = 600_000;
    expect(limiter.take("a").ok).toBe(true);
  });

  it("enforces the global budget across visitors", () => {
    let now = 0;
    const limiter = new VisitorRateLimiter({ globalPerMinute: 3, clock: { nowMs: () => now } });
    expect(["a", "b", "c"].map((key) => limiter.take(key).ok)).toEqual([true, true, true]);
    expect(limiter.take("d").ok).toBe(false);
    now += 60_000;
    expect(limiter.take("d").ok).toBe(true);
  });

  it("does not track rejected visitors and forgets idle ones", () => {
    let now = 0;
    const limiter = new VisitorRateLimiter({ globalPerMinute: 1, clock: { nowMs: () => now } });
    limiter.take("a");
    for (let index = 0; index < 100; index += 1) {
      limiter.take(`flood-${String(index)}`);
    }
    expect(limiter.trackedKeys()).toBe(1);
    now += 600_000;
    limiter.take("b");
    expect(limiter.trackedKeys()).toBe(1);
  });
});

describe("DailyBudget", () => {
  it("allows max per UTC day and says how long until midnight", () => {
    let now = Date.parse("2026-10-06T23:00:00Z");
    const budget = new DailyBudget(2, { nowMs: () => now });
    expect(budget.check().ok).toBe(true);
    budget.record();
    budget.record();
    expect(budget.check()).toEqual({ ok: false, retryAfterMs: 3_600_000 });
    now = Date.parse("2026-10-07T00:00:00Z");
    expect(budget.check().ok).toBe(true);
  });
});

describe("parseSay", () => {
  it("cleans and accepts a normal message", () => {
    expect(parseSay({ name: "  Ada\u0007 \u202ELovelace ", text: " hi\r\nthere\u0000 " })).toEqual({
      ok: true,
      value: { name: "Ada Lovelace", text: "hi\nthere" }
    });
  });

  it.each([
    [{ text: "hi" }, "invalid_name"],
    [{ name: "   ", text: "hi" }, "invalid_name"],
    [{ name: "x".repeat(33), text: "hi" }, "invalid_name"],
    [{ name: "The Wanderer", text: "hi" }, "invalid_name"],
    [{ name: "wanderer", text: "hi" }, "invalid_name"],
    [{ name: "The Wan\u200Bderer", text: "hi" }, "invalid_name"],
    [{ name: "the wanderer.", text: "hi" }, "invalid_name"],
    [{ name: "THE  WANDERER", text: "hi" }, "invalid_name"],
    [{ name: "The_Wanderer!", text: "hi" }, "invalid_name"],
    [{ name: "\uFF37\uFF41\uFF4E\uFF44\uFF45\uFF52\uFF45\uFF52", text: "hi" }, "invalid_name"],
    [{ name: "the\u00ADwan\u2060derer", text: "hi" }, "invalid_name"],
    [{ name: "\u200B\u200D\uFEFF", text: "hi" }, "invalid_name"],
    [{ name: "Ada", text: "" }, "invalid_text"],
    [{ name: "Ada", text: "\u0001\u0002" }, "invalid_text"],
    [{ name: "Ada", text: "y".repeat(501) }, "invalid_text"],
    [{ name: "Ada", text: 42 }, "invalid_text"],
    [null, "invalid_name"],
    [["Ada", "hi"], "invalid_name"]
  ])("rejects %j", (body, code) => {
    const result = parseSay(body);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe(code);
  });

  it("strips invisible format characters (Cf) from names and text", () => {
    expect(
      parseSay({ name: "A\u200Bd\u00ADa\uFEFF", text: "hi\u200B the\u{E0041}\u{E0042}re\u2060" })
    ).toEqual({ ok: true, value: { name: "Ada", text: "hi there" } });
    // The zero-width joiner is kept in text so emoji sequences survive.
    expect(parseSay({ name: "Ada", text: "\u{1F469}\u200D\u{1F4BB}" })).toEqual({
      ok: true,
      value: { name: "Ada", text: "\u{1F469}\u200D\u{1F4BB}" }
    });
  });

  it("refuses the Wanderer's name disguised with default-ignorable fillers", () => {
    for (const name of [
      "The Wanderer\u3164",
      "W\u3164anderer",
      "Wanderer\u115F",
      "Wand\uFFA0erer"
    ]) {
      expect(parseSay({ name, text: "hi" })).toMatchObject({ ok: false, code: "invalid_name" });
    }
    expect(foldName("W\u3164anderer")).toBe("wanderer");
    // A name of fillers only is empty after cleaning.
    expect(parseSay({ name: "\u3164\u115F", text: "hi" })).toMatchObject({
      ok: false,
      code: "invalid_name"
    });
  });

  it("strips default-ignorables from text but keeps emoji joiners and variation selectors", () => {
    expect(
      parseSay({ name: "Ada", text: "h\u3164i \u2764\uFE0F \u{1F469}\u200D\u{1F4BB}" })
    ).toEqual({
      ok: true,
      value: { name: "Ada", text: "hi \u2764\uFE0F \u{1F469}\u200D\u{1F4BB}" }
    });
  });

  it("allows names that merely contain the word", () => {
    expect(parseSay({ name: "Wanderer's friend", text: "hi" }).ok).toBe(true);
    expect(foldName(" The  Wanderer. ")).toBe("thewanderer");
  });

  it("counts code points, not UTF-16 units", () => {
    expect(parseSay({ name: "🙂".repeat(32), text: "🌙".repeat(500) }).ok).toBe(true);
  });
});

describe("addressing and relay text", () => {
  it("flags mentions of the Wanderer and leading @", () => {
    expect(isAddressed("hey WANDERER")).toBe(true);
    expect(isAddressed("@anyone around?")).toBe(true);
    expect(isAddressed("nice evening")).toBe(false);
  });

  it("drops @ from handles in relayed text only", () => {
    expect(relayText("@Wanderer hi, ask @bob_2 or mail a@b.co")).toBe(
      "Wanderer hi, ask bob_2 or mail a@b.co"
    );
  });
});

function fakeRequest(remoteAddress: string, forwarded?: string | string[]): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded }
  } as unknown as IncomingMessage;
}

describe("clientIp", () => {
  it("uses the socket address unless the proxy is trusted", () => {
    expect(clientIp(fakeRequest("::ffff:10.0.0.9", "1.2.3.4"), false)).toBe("10.0.0.9");
  });

  it("uses the LAST X-Forwarded-For hop when trusted", () => {
    expect(clientIp(fakeRequest("10.0.0.9", "6.6.6.6, 203.0.113.7"), true)).toBe("203.0.113.7");
    expect(clientIp(fakeRequest("10.0.0.9", ["6.6.6.6", "203.0.113.8 "]), true)).toBe(
      "203.0.113.8"
    );
    expect(clientIp(fakeRequest("10.0.0.9", "2001:db8::1"), true)).toBe("2001:db8::1");
  });

  it("falls back to the socket for a missing or bogus header", () => {
    expect(clientIp(fakeRequest("10.0.0.9"), true)).toBe("10.0.0.9");
    expect(clientIp(fakeRequest("10.0.0.9", "1.2.3.4, <script>"), true)).toBe("10.0.0.9");
    expect(clientIp(fakeRequest("10.0.0.9", " , "), true)).toBe("10.0.0.9");
  });
});

describe("clientKey", () => {
  it("keeps IPv4 and folds IPv4-mapped IPv6 to IPv4", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(clientKey("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("keys IPv6 by its /64 prefix", () => {
    const key = clientKey("2001:db8:1:2::1");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(key);
    expect(clientKey("2001:db8:1:2:a:b:1.2.3.4")).toBe(key);
    expect(clientKey("2001:db8:1:3::1")).not.toBe(key);
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("passes through anything else unchanged", () => {
    expect(clientKey("unknown")).toBe("unknown");
  });
});

describe("VisitorIds", () => {
  it("is stable within a day, rotates daily, and never contains the IP", () => {
    let now = Date.parse("2026-10-06T10:00:00Z");
    const ids = new VisitorIds({ nowMs: () => now });
    const first = ids.idFor("203.0.113.7");
    expect(first).toMatch(/^web-[0-9a-f]{12}$/u);
    expect(ids.idFor("203.0.113.7")).toBe(first);
    expect(ids.idFor("203.0.113.8")).not.toBe(first);
    now += 24 * 3600 * 1000;
    expect(ids.idFor("203.0.113.7")).not.toBe(first);
  });
});

describe("Room", () => {
  it("keeps a bounded ring and records distinct reactions", () => {
    const room = new Room();
    const seen: string[] = [];
    room.subscribe((event) => seen.push(event.type));
    for (let index = 0; index < ROOM_CAPACITY + 5; index += 1) {
      room.append({ id: `m${String(index)}`, at: "t", from: "visitor", name: "a", text: "x" });
    }
    expect(room.recent(1000)).toHaveLength(ROOM_CAPACITY);
    expect(room.recent(1)[0]?.id).toBe(`m${String(ROOM_CAPACITY + 4)}`);
    expect(room.react("m0", "👋")).toBe(false);
    expect(room.react("m10", "👋")).toBe(true);
    expect(room.react("m10", "👋")).toBe(true);
    expect(room.recent(1000).find((message) => message.id === "m10")?.reactions).toEqual(["👋"]);
    expect(seen.filter((type) => type === "reaction")).toHaveLength(2);
  });
});

describe("loadDoorKeypairFromPath", () => {
  it("accepts raw 32 bytes or base64url, rejects anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "door-web-keyfmt-"));
    try {
      const key = generateKeypair();
      const raw = join(dir, "raw.key");
      const b64 = join(dir, "b64.key");
      const bad = join(dir, "bad.key");
      writeFileSync(raw, Buffer.from(key.privateKey));
      writeFileSync(b64, `${encodeBase64Url(key.privateKey)}\n`);
      writeFileSync(bad, encodeBase64Url(new Uint8Array(16)));
      expect(loadDoorKeypairFromPath(raw).publicKey).toEqual(key.publicKey);
      expect(loadDoorKeypairFromPath(b64).publicKey).toEqual(key.publicKey);
      expect(() => loadDoorKeypairFromPath(bad)).toThrow(WebDoorError);
      expect(() => loadDoorKeypairFromPath(join(dir, "missing.key"))).toThrow(WebDoorError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AtlasWhereabouts", () => {
  it("reads /state, caches it, and tolerates failures", async () => {
    let now = 0;
    let calls = 0;
    let reply: () => Response = () =>
      Response.json({
        status: "present",
        door_id: "discord:1",
        epoch: 4,
        since: "2026-10-06T08:00:00Z",
        last_record_at: "2026-10-06T09:30:00Z",
        verified: true
      });
    const fetchImpl = ((url: string) => {
      calls += 1;
      expect(url).toBe("http://atlas/state");
      return Promise.resolve(reply());
    }) as typeof fetch;
    const atlas = new AtlasWhereabouts("http://atlas", () => now, fetchImpl);
    expect(await atlas.get()).toEqual({
      status: "present",
      door_id: "discord:1",
      since: "2026-10-06T08:00:00Z"
    });
    await atlas.get();
    expect(calls).toBe(1);

    now += 60_000;
    reply = () => new Response("nope", { status: 500 });
    expect(await atlas.get()).toBeNull();
    now += 60_000;
    reply = () => Response.json({ status: "<script>" });
    expect(await atlas.get()).toBeNull();
    now += 60_000;
    reply = () => {
      throw new Error("down");
    };
    expect(await atlas.get()).toBeNull();
  });
});
