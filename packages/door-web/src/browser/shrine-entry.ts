import "./jitless.js";
import {
  mountShrine,
  readShrineConfig,
  type ShrineDocument,
  type ShrineElement
} from "./shrine.js";

/**
 * Mount the shrine on `host` when it is a page.
 * Failures stay inside the embed so the host page keeps running.
 */
export function bootShrine(host: unknown): void {
  const bound = bindShrineHost(host);
  if (bound === null) {
    return;
  }
  try {
    const config = readShrineConfig(bound.currentScript, bound.wandererShrine);
    mountShrine({
      document: bound.document,
      config,
      fetchImpl: bound.fetch,
      setInterval: bound.setInterval
    });
  } catch {
    // The embed must not throw into the host page.
  }
}

/** Page operations whose calls keep that page as `this`. */
export type ShrineHostBindings = {
  document: ShrineDocument;
  currentScript: PageScript | null;
  wandererShrine: unknown;
  fetch: typeof fetch;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
};

type PageScript = {
  dataset: { atlasUrl?: string; porchUrl?: string; mount?: string };
};

/**
 * Bind `setInterval`, `clearInterval`, `fetch`, and document methods to `host`.
 * Each wrapper calls the page directly, for example `(fn, ms) => host.setInterval(fn, ms)`.
 * Returns null when `host` has no document, fetch, or timers.
 */
export function bindShrineHost(host: unknown): ShrineHostBindings | null {
  if (!isPage(host)) {
    return null;
  }
  const page = host;
  const fetchImpl: typeof fetch = (input, init) => page.fetch(input, init);
  return {
    document: bindDocument(page.document),
    currentScript: page.document.currentScript,
    wandererShrine: "WANDERER_SHRINE" in page ? page.WANDERER_SHRINE : undefined,
    fetch: fetchImpl,
    setInterval: (fn, ms) => page.setInterval(fn, ms),
    clearInterval: (id) => page.clearInterval(id)
  };
}

function bindDocument(doc: Page["document"]): ShrineDocument {
  return {
    get visibilityState(): string {
      return doc.visibilityState;
    },
    querySelector: (selector: string): ShrineElement | null => doc.querySelector(selector),
    createElement: (tag: string): ShrineElement => doc.createElement(tag),
    addEventListener: (type: string, listener: () => void): void => {
      doc.addEventListener(type, listener);
    }
  };
}

type Page = {
  document: ShrineDocument & {
    currentScript: PageScript | null;
  };
  fetch: typeof fetch;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  WANDERER_SHRINE?: unknown;
};

function isPage(value: unknown): value is Page {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    !("document" in value) ||
    !("fetch" in value) ||
    !("setInterval" in value) ||
    !("clearInterval" in value)
  ) {
    return false;
  }
  return (
    isDocument(value.document) &&
    typeof value.fetch === "function" &&
    typeof value.setInterval === "function" &&
    typeof value.clearInterval === "function"
  );
}

function isDocument(value: unknown): value is Page["document"] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "querySelector" in value &&
    typeof value.querySelector === "function" &&
    "createElement" in value &&
    typeof value.createElement === "function" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "visibilityState" in value &&
    typeof value.visibilityState === "string" &&
    "currentScript" in value
  );
}

/**
 * Classic-script entry for the replica shrine. Bundled to `public/shrine.js`.
 * Reads `globalThis.WANDERER_SHRINE` or the script's `data-*` attributes.
 */
bootShrine(globalThis);
