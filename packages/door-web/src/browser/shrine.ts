import {
  loadShrine,
  SHRINE_FAILED_SNAPSHOT,
  type ShrineCache,
  type ShrineConfig,
  type ShrineSnapshot
} from "./shrine-chain.js";

/** How often an open shrine refetches the export (`spec/door/web.md`). */
export const SHRINE_REFRESH_MS = 60_000;

/** Default mount when `data-mount` and `WANDERER_SHRINE.mount` are absent. */
export const DEFAULT_SHRINE_MOUNT = "#wanderer-shrine";

/** Placeholder painted before the first export returns. Never `PRESENT`. */
export const CHECKING_SNAPSHOT: ShrineSnapshot = {
  phase: "checking",
  badge: "ELSEWHERE",
  detail: "checking",
  doorId: null,
  porchUrl: null,
  journals: []
};

/** Element methods the renderer uses. Real DOM nodes satisfy this. */
export type ShrineElement = {
  textContent: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: ShrineElement): void;
  attachShadow(init: { mode: "closed" }): ShrineRoot;
};

/** Closed shadow root. Setting `textContent` clears the previous paint. */
export type ShrineRoot = {
  textContent: string;
  appendChild(child: ShrineElement): void;
  adoptedStyleSheets?: readonly unknown[];
};

/** The slice of `document` the embed needs. */
export type ShrineDocument = {
  visibilityState: string;
  querySelector(selector: string): ShrineElement | null;
  createElement(tag: string): ShrineElement;
  addEventListener(type: string, listener: () => void): void;
};

type ScriptDataset = {
  atlasUrl?: string;
  porchUrl?: string;
  mount?: string;
};

/**
 * Read embed settings. For each field, `globalThis.WANDERER_SHRINE` wins when
 * that field is present; a field it omits still comes from `data-*`.
 * `atlasUrl` must be an absolute `http:` or `https:` URL.
 */
export function readShrineConfig(
  script: { dataset: ScriptDataset } | null,
  globalConfig: unknown
): ShrineConfig {
  const source = plainObject(globalConfig);
  const dataset = script === null ? {} : script.dataset;
  const mount = picked(source, "mount", dataset.mount);
  return {
    atlasUrl: httpOrigin(picked(source, "atlasUrl", dataset.atlasUrl)),
    porchUrl: httpHref(picked(source, "porchUrl", dataset.porchUrl)),
    mount: mount !== undefined && mount !== "" ? mount : DEFAULT_SHRINE_MOUNT,
    soulPublicKey: owns(source, "soulPublicKey") ? soulPin(source) : null,
    doorPublicKeys: owns(source, "doorPublicKeys") ? doorKeyPin(source) : null
  };
}

/**
 * Paint one snapshot. The badge is the first element. Chain text is assigned
 * with `textContent` only.
 */
export function renderShrine(
  document: { createElement(tag: string): ShrineElement },
  root: ShrineRoot,
  snapshot: ShrineSnapshot
): void {
  root.textContent = "";
  const badge = document.createElement("p");
  badge.textContent = snapshot.badge;
  root.appendChild(badge);
  if (snapshot.detail !== null) {
    const detail = document.createElement("p");
    detail.textContent = snapshot.detail;
    root.appendChild(detail);
  }
  if (snapshot.doorId !== null) {
    const door = document.createElement("p");
    door.textContent = snapshot.doorId;
    root.appendChild(door);
  }
  if (snapshot.porchUrl !== null) {
    const link = document.createElement("a");
    link.setAttribute("href", snapshot.porchUrl);
    link.textContent = "porch";
    root.appendChild(link);
  }
  if (snapshot.journals.length === 0) {
    return;
  }
  const list = document.createElement("ul");
  for (const journal of snapshot.journals) {
    const item = document.createElement("li");
    item.textContent = journal;
    list.appendChild(item);
  }
  root.appendChild(list);
}

/**
 * Mount into `config.mount`, paint `checking` first, then refetch when the
 * document becomes visible and on a timer. The visibility listener is
 * registered before the interval starts, so a timer failure cannot disable
 * both refresh paths.
 */
export function mountShrine(options: {
  document: ShrineDocument;
  config: ShrineConfig;
  fetchImpl: typeof fetch;
  setInterval: (fn: () => void, ms: number) => number;
}): void {
  const host = options.document.querySelector(options.config.mount);
  if (host === null) {
    return;
  }
  const shadow = host.attachShadow({ mode: "closed" });
  adoptBadgeStyle(shadow);
  if (options.config.atlasUrl === null) {
    renderShrine(options.document, shadow, SHRINE_FAILED_SNAPSHOT);
    return;
  }
  renderShrine(options.document, shadow, CHECKING_SNAPSHOT);
  let cache: ShrineCache | null = null;
  let busy = false;
  const tick = (): void => {
    if (busy) {
      return;
    }
    busy = true;
    void loadShrine(options.config, cache, options.fetchImpl)
      .then((next) => {
        cache = next;
      })
      .catch(() => {
        cache = { etag: null, snapshot: SHRINE_FAILED_SNAPSHOT, client: null };
      })
      .finally(() => {
        busy = false;
        const snapshot = cache === null ? SHRINE_FAILED_SNAPSHOT : cache.snapshot;
        renderShrine(options.document, shadow, snapshot);
      });
  };
  tick();
  options.document.addEventListener("visibilitychange", () => {
    if (options.document.visibilityState === "visible") {
      tick();
    }
  });
  options.setInterval(() => {
    if (options.document.visibilityState === "hidden") {
      return;
    }
    tick();
  }, SHRINE_REFRESH_MS);
}

function picked(
  source: Record<string, unknown> | null,
  key: string,
  fallback: string | undefined
): string | undefined {
  if (!owns(source, key)) {
    return fallback;
  }
  return stringField(source, key);
}

function owns(
  source: Record<string, unknown> | null,
  key: string
): source is Record<string, unknown> {
  return source !== null && Object.prototype.hasOwnProperty.call(source, key);
}

/** Bold the badge inside the shadow, once, without a style element the host CSP would block. */
function adoptBadgeStyle(root: ShrineRoot): void {
  const sheet = badgeSheet();
  if (sheet === null) {
    return;
  }
  root.adoptedStyleSheets = [sheet];
}

function badgeSheet(): { replaceSync(css: string): void } | null {
  const host: unknown = globalThis;
  if (typeof host !== "object" || host === null || !("CSSStyleSheet" in host)) {
    return null;
  }
  const ctor: unknown = host.CSSStyleSheet;
  if (!isSheetCtor(ctor)) {
    return null;
  }
  const sheet = new ctor();
  sheet.replaceSync("p:first-child{font-weight:700;font-size:1.25rem;letter-spacing:.04em}");
  return sheet;
}

function isSheetCtor(value: unknown): value is new () => { replaceSync(css: string): void } {
  return typeof value === "function";
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = entry;
  }
  return copy;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function soulPin(source: Record<string, unknown>): string | null {
  if (!("soulPublicKey" in source)) {
    return null;
  }
  const value = source["soulPublicKey"];
  return typeof value === "string" ? value : "";
}

function doorKeyPin(source: Record<string, unknown>): Record<string, string> | null {
  if (!("doorPublicKeys" in source)) {
    return null;
  }
  const value = source["doorPublicKeys"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const keys: Record<string, string> = {};
  for (const [doorId, encoded] of Object.entries(value)) {
    if (typeof encoded !== "string") {
      return {};
    }
    keys[doorId] = encoded;
  }
  return keys;
}

function httpOrigin(value: string | undefined): string | null {
  return parsedHttp(value, "origin");
}

function httpHref(value: string | undefined): string | null {
  return parsedHttp(value, "href");
}

function parsedHttp(value: string | undefined, part: "origin" | "href"): string | null {
  if (value === undefined || value === "") {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.origin === "null") {
      return null;
    }
    return part === "origin" ? url.origin : url.href;
  } catch {
    return null;
  }
}
