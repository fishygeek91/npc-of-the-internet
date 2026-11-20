import { readFileSync } from "node:fs";

import {
  encodeBase64Url,
  encodeJournalBlob,
  encodePublicKey,
  generateKeypair,
  POP_VERSION
} from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { loadShrine } from "../src/browser/shrine-chain.js";
import {
  mountShrine,
  readShrineConfig,
  SHRINE_REFRESH_MS,
  type ShrineElement
} from "../src/browser/shrine.js";
import {
  DOOR_ID,
  LEAK,
  pins,
  PROSE,
  serveExport,
  stay,
  witnessed,
  type ServedExport
} from "./shrine-fixture.js";

describe("shrine embed", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  it("merges each WANDERER_SHRINE field over data attributes and rejects a non-http atlas", () => {
    const partial = readShrineConfig(
      {
        dataset: {
          atlasUrl: "https://data.example",
          porchUrl: "https://data.example/porch",
          mount: "#data"
        }
      },
      { soulPublicKey: "pin" }
    );
    expect(partial.atlasUrl).toBe("https://data.example");
    expect(partial.porchUrl).toBe("https://data.example/porch");
    expect(partial.mount).toBe("#data");
    expect(partial.soulPublicKey).toBe("pin");
    const replaced = readShrineConfig(
      { dataset: { atlasUrl: "https://data.example", mount: "#data" } },
      { atlasUrl: "https://object.example/atlas", mount: "#object" }
    );
    expect(replaced.atlasUrl).toBe("https://object.example");
    expect(replaced.mount).toBe("#object");
    expect(
      readShrineConfig({ dataset: { atlasUrl: "ftp://atlas.example" } }, undefined).atlasUrl
    ).toBe(null);
  });

  it("leaves PRESENT after a departure, and omits a blob whose hash does not match", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const awake = await stay(soul, door);
    const left = await witnessed(soul, door, awake.records.length, awake.headCid, "attestation", {
      kind: "departure",
      pop_version: POP_VERSION,
      door_id: DOOR_ID,
      epoch: 1,
      at: "2026-01-04T00:00:00.000Z"
    });
    const gone = {
      records: [...awake.records, left.record],
      blobs: awake.blobs,
      journalCid: awake.journalCid
    };
    const departed = await serveExport({
      records: gone.records,
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
      blobs: gone.blobs
    });
    closers.push(departed.close);
    const away = await loadShrine(pins(departed.url, soul), null);
    expect(away.snapshot.badge).toBe("ELSEWHERE");
    expect(away.snapshot.detail).toBe("traveling");
    expect(away.snapshot.journals).toEqual([PROSE]);
    const tampered = {
      ...gone.blobs,
      [gone.journalCid]: encodeBase64Url(encodeJournalBlob("nope"))
    };
    const mismatched = await serveExport({
      records: gone.records.slice(0, -1),
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
      blobs: tampered
    });
    closers.push(mismatched.close);
    const hidden = await loadShrine(pins(mismatched.url, soul), null);
    expect(hidden.snapshot.badge).toBe("PRESENT");
    expect(hidden.snapshot.journals).toEqual([]);
  });

  it("keeps the verified snapshot when the export answers 304", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const built = await stay(soul, door);
    const served = await serveExport(
      {
        records: built.records,
        doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
        blobs: built.blobs
      },
      { etag: '"shrine"', emptyTail: true }
    );
    closers.push(served.close);
    const first = await loadShrine(pins(served.url, soul), null);
    expect(first.snapshot.badge).toBe("PRESENT");
    const again = await loadShrine(pins(served.url, soul), first);
    expect(again.snapshot).toBe(first.snapshot);
    const third = await loadShrine(pins(served.url, soul), again);
    expect(third.snapshot).toBe(first.snapshot);
  });

  it("paints ELSEWHERE while checking, then the badge first inside a closed shadow", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const built = await stay(soul, door);
    const served = await serveExport({
      records: built.records,
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
      blobs: built.blobs
    });
    closers.push(served.close);
    const page = fakePage();
    const intervals: number[] = [];
    let onInterval = (): void => undefined;
    mountShrine({
      document: page.document,
      config: pins(served.url, soul),
      fetchImpl: fetch,
      setInterval: (fn, ms) => {
        intervals.push(ms);
        onInterval = fn;
        return 1;
      }
    });
    const shadow = page.host.shadow;
    expect(shadow).not.toBeNull();
    expect(page.host.shadowMode).toBe("closed");
    expect(shadow?.children[0]?.textContent).toBe("ELSEWHERE");
    expect(shadow?.children[1]?.textContent).toBe("checking");
    await waitFor(() => shadow?.children[0]?.textContent, "PRESENT");
    expect(JSON.stringify(shadow?.children.map((child) => child.textContent))).not.toContain(LEAK);
    expect(intervals).toEqual([SHRINE_REFRESH_MS]);
    page.document.visibilityState = "hidden";
    onInterval();
    expect(shadow?.children[0]?.textContent).toBe("PRESENT");
    page.document.visibilityState = "visible";
    page.onVisible();
    expect(shadow?.children[0]?.textContent).toBe("PRESENT");
    for (const name of ["shrine.ts", "shrine-chain.ts", "shrine-entry.ts"]) {
      const source = readFileSync(new URL(`../src/browser/${name}`, import.meta.url), "utf8");
      expect(source).not.toContain("innerHTML");
      expect(source).not.toContain("/api/say");
    }
    const shrineSource = readFileSync(new URL("../src/browser/shrine.ts", import.meta.url), "utf8");
    expect(shrineSource).toContain('visibilityState === "hidden"');
    expect(shrineSource).toContain("adoptedStyleSheets");
  });

  it("follows a mounted shrine from PRESENT to ELSEWHERE and back", async () => {
    let built = 0;
    class CountingSheet {
      replaceSync(css: string): void {
        built += css.length > 0 ? 1 : 0;
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "CSSStyleSheet");
    Object.defineProperty(globalThis, "CSSStyleSheet", {
      configurable: true,
      writable: true,
      value: CountingSheet
    });
    try {
      const soul = generateKeypair();
      const door = generateKeypair();
      const awake = await stay(soul, door);
      const left = await witnessed(soul, door, awake.records.length, awake.headCid, "attestation", {
        kind: "departure",
        pop_version: POP_VERSION,
        door_id: DOOR_ID,
        epoch: 1,
        at: "2026-01-04T00:00:00.000Z"
      });
      const present = {
        records: awake.records,
        doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
        blobs: awake.blobs
      };
      const live: ServedExport = { body: present, etag: '"here"', status: 200 };
      const served = await serveExport(present, { live });
      closers.push(served.close);
      const page = fakePage();
      let onInterval = (): void => undefined;
      mountShrine({
        document: page.document,
        config: pins(served.url, soul),
        fetchImpl: fetch,
        setInterval: (fn) => {
          onInterval = fn;
          return 1;
        }
      });
      const shadow = page.host.shadow;
      await waitFor(() => shadow?.children[0]?.textContent, "PRESENT");
      page.document.visibilityState = "visible";
      page.onVisible();
      await pause();
      expect(shadow?.children[0]?.textContent).toBe("PRESENT");

      live.body = {
        records: [...awake.records, left.record],
        doorPublicKeys: present.doorPublicKeys,
        blobs: awake.blobs
      };
      live.etag = '"gone"';
      page.document.visibilityState = "hidden";
      onInterval();
      await pause();
      expect(shadow?.children[0]?.textContent).toBe("PRESENT");
      page.document.visibilityState = "visible";
      page.onVisible();
      await waitFor(() => shadow?.children[0]?.textContent, "ELSEWHERE");
      expect(shadow?.children[1]?.textContent).toBe("traveling");
      expect(allText(shadow)).toContain(PROSE);

      const returned = generateKeypair();
      const back = await witnessed(
        soul,
        door,
        awake.records.length + 1,
        left.cid,
        "attestation",
        {
          kind: "arrival",
          pop_version: POP_VERSION,
          door_id: DOOR_ID,
          epoch: 2,
          session_pubkey: encodePublicKey(returned.publicKey),
          at: "2026-01-05T00:00:00.000Z"
        },
        `door:${DOOR_ID}/epoch:2`
      );
      live.body = {
        records: [...awake.records, left.record, back.record],
        doorPublicKeys: present.doorPublicKeys,
        blobs: awake.blobs
      };
      live.etag = '"back"';
      page.onVisible();
      await waitFor(() => shadow?.children[0]?.textContent, "PRESENT");

      live.status = 500;
      live.etag = '"down"';
      page.onVisible();
      await waitFor(() => shadow?.children[1]?.textContent, "verification failed");
      expect(shadow?.children[0]?.textContent).toBe("ELSEWHERE");
      expect(allText(shadow)).not.toContain(PROSE);
      expect(built).toBe(1);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "CSSStyleSheet");
      } else {
        Object.defineProperty(globalThis, "CSSStyleSheet", descriptor);
      }
    }
  });
});

function allText(node: FakeNode | null): string {
  if (node === null) {
    return "";
  }
  const nested = node.children.map((child) => allText(child)).join("\n");
  return `${node.textContent}\n${nested}`;
}

function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

async function waitFor(read: () => string | undefined, expected: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (read() === expected) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${expected}`);
}

class FakeNode implements ShrineElement {
  children: FakeNode[] = [];
  shadow: FakeNode | null = null;
  shadowMode: string | null = null;
  private text = "";
  get textContent(): string {
    return this.text;
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  setAttribute(): void {
    return;
  }
  appendChild(child: ShrineElement): void {
    if (child instanceof FakeNode) {
      this.children.push(child);
    }
  }
  attachShadow(init: { mode: "closed" }): FakeNode {
    this.shadowMode = init.mode;
    this.shadow = new FakeNode();
    return this.shadow;
  }
}

function fakePage(): { document: ShrineDocumentLike; host: FakeNode; onVisible: () => void } {
  const host = new FakeNode();
  let onVisible = (): void => undefined;
  const document = {
    visibilityState: "hidden",
    querySelector: () => host,
    createElement: () => new FakeNode(),
    addEventListener: (_type: string, listener: () => void) => {
      onVisible = listener;
    }
  };
  return { document, host, onVisible: () => onVisible() };
}

type ShrineDocumentLike = {
  visibilityState: string;
  querySelector(selector: string): ShrineElement | null;
  createElement(tag: string): ShrineElement;
  addEventListener(type: string, listener: () => void): void;
};
