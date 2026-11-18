import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SHRINE_REFRESH_MS, type ShrineElement } from "../src/browser/shrine.js";
import { bindShrineHost, bootShrine } from "../src/browser/shrine-entry.js";

const ATLAS_ORIGIN = "https://atlas.example";
const EXPORT_URL = `${ATLAS_ORIGIN}/chain/export`;

describe("shrine entry receivers", () => {
  it("refetches when timers, fetch, and document methods keep the page as this", async () => {
    const rig = receiverPage();
    const stolenInterval = rig.fakeWindow.setInterval;
    const stolenFetch = rig.fakeWindow.fetch;
    const stolenQuery = rig.fakeWindow.document.querySelector;
    expect(() => {
      stolenInterval(() => undefined, 1);
    }).toThrow(TypeError);
    expect(() => {
      void stolenFetch(EXPORT_URL);
    }).toThrow(TypeError);
    expect(() => {
      stolenQuery("#wanderer-shrine");
    }).toThrow(TypeError);

    bootShrine(rig.fakeWindow);

    const listenerAt = rig.order.indexOf("visibilitychange");
    const intervalAt = rig.order.indexOf("setInterval");
    expect(listenerAt).toBeGreaterThanOrEqual(0);
    expect(intervalAt).toBeGreaterThan(listenerAt);
    expect(rig.fetches).toEqual([EXPORT_URL]);
    expect(rig.intervals.map((item) => item.ms)).toEqual([SHRINE_REFRESH_MS]);

    const interval = rig.intervals[0];
    if (interval === undefined) {
      throw new Error("interval was not scheduled");
    }
    await flush();
    rig.fakeWindow.document.visibilityState = "hidden";
    interval.fn();
    await flush();
    expect(rig.fetches).toEqual([EXPORT_URL]);

    rig.show();
    await flush();
    expect(rig.fetches).toEqual([EXPORT_URL, EXPORT_URL]);
  });

  it("binds clearInterval to the page", () => {
    const rig = receiverPage();
    const bound = bindShrineHost(rig.fakeWindow);
    if (bound === null) {
      throw new Error("expected a page");
    }
    const stolen = rig.fakeWindow.clearInterval;
    expect(() => {
      stolen(4);
    }).toThrow(TypeError);
    bound.clearInterval(4);
    expect(rig.cleared).toEqual([4]);
    expect(bindShrineHost({})).toBeNull();
  });

  it("does not pass the page's timer or fetch through another object", () => {
    const source = readFileSync(new URL("../src/browser/shrine-entry.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/setInterval:\s*host\.setInterval/);
    expect(source).not.toMatch(/fetchImpl:\s*host\.fetch/);
    expect(source).toContain("page.setInterval(fn, ms)");
    expect(source).toContain("page.fetch(input, init)");
    expect(source).toContain("page.clearInterval(id)");
  });
});

type IntervalCall = {
  fn: () => void;
  ms: number;
};

type ReceiverWindow = {
  document: ReceiverDocument;
  fetch: typeof fetch;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  WANDERER_SHRINE: undefined;
};

type ReceiverDocument = {
  visibilityState: string;
  currentScript: { dataset: { atlasUrl: string; mount: string } };
  querySelector(selector: string): ShrineElement | null;
  createElement(tag: string): ShrineElement;
  addEventListener(type: string, listener: () => void): void;
};

type ReceiverRig = {
  fakeWindow: ReceiverWindow;
  order: string[];
  fetches: string[];
  intervals: IntervalCall[];
  cleared: number[];
  show: () => void;
};

class FakeNode implements ShrineElement {
  textContent = "";
  setAttribute(): void {
    return;
  }
  appendChild(): void {
    return;
  }
  attachShadow(): FakeNode {
    return new FakeNode();
  }
}

function receiverPage(): ReceiverRig {
  const order: string[] = [];
  const fetches: string[] = [];
  const intervals: IntervalCall[] = [];
  const cleared: number[] = [];
  let visibilityState = "hidden";
  let onVisible: (() => void) | null = null;
  let fakeWindow: ReceiverWindow | null = null;
  let fakeDocument: ReceiverDocument | null = null;
  const host = new FakeNode();

  const document: ReceiverDocument = {
    currentScript: {
      dataset: { atlasUrl: ATLAS_ORIGIN, mount: "#wanderer-shrine" }
    },
    get visibilityState(): string {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      return visibilityState;
    },
    set visibilityState(value: string) {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      visibilityState = value;
    },
    querySelector(selector: string): ShrineElement | null {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      return selector === "#wanderer-shrine" ? host : null;
    },
    createElement(): ShrineElement {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      return new FakeNode();
    },
    addEventListener(type: string, listener: () => void): void {
      if (this !== fakeDocument) {
        throw new TypeError("Illegal invocation");
      }
      if (type !== "visibilitychange") {
        return;
      }
      order.push("visibilitychange");
      onVisible = listener;
    }
  };

  function fetchImpl(
    this: unknown,
    input: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1]
  ): Promise<Response> {
    if (this !== fakeWindow) {
      throw new TypeError("Illegal invocation");
    }
    order.push("fetch");
    fetches.push(String(input));
    return Promise.resolve(new Response(null, { status: 500 }));
  }

  function setInterval(this: unknown, fn: () => void, ms: number): number {
    if (this !== fakeWindow) {
      throw new TypeError("Illegal invocation");
    }
    order.push("setInterval");
    intervals.push({ fn, ms });
    return 1;
  }

  function clearInterval(this: unknown, id: number): void {
    if (this !== fakeWindow) {
      throw new TypeError("Illegal invocation");
    }
    cleared.push(id);
  }

  const page: ReceiverWindow = {
    document,
    fetch: fetchImpl,
    setInterval,
    clearInterval,
    WANDERER_SHRINE: undefined
  };
  fakeWindow = page;
  fakeDocument = document;
  return {
    fakeWindow: page,
    order,
    fetches,
    intervals,
    cleared,
    show(): void {
      document.visibilityState = "visible";
      if (onVisible === null) {
        throw new Error("visibilitychange listener was not registered");
      }
      onVisible();
    }
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
}
