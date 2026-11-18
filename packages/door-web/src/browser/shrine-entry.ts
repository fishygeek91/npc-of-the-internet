import "./jitless.js";
import { mountShrine, readShrineConfig, type ShrineDocument } from "./shrine.js";

/**
 * Classic-script entry for the replica shrine. Bundled to `public/shrine.js`.
 * Reads `globalThis.WANDERER_SHRINE` or the script's `data-*` attributes.
 */
const host: unknown = globalThis;
if (isPage(host)) {
  try {
    const config = readShrineConfig(host.document.currentScript, host.WANDERER_SHRINE);
    mountShrine({
      document: host.document,
      config,
      fetchImpl: host.fetch,
      setInterval: host.setInterval
    });
  } catch {
    // The embed must not throw into the host page.
  }
}

type Page = {
  document: ShrineDocument & {
    currentScript: { dataset: { atlasUrl?: string; porchUrl?: string; mount?: string } } | null;
  };
  fetch: typeof fetch;
  setInterval: (fn: () => void, ms: number) => number;
  WANDERER_SHRINE: unknown;
};

function isPage(value: unknown): value is Page {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("document" in value) || !("fetch" in value) || !("setInterval" in value)) {
    return false;
  }
  return (
    isDocument(value.document) &&
    typeof value.fetch === "function" &&
    typeof value.setInterval === "function"
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
