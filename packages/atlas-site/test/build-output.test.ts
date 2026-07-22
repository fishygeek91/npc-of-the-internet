import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { loadSiteData } from "../src/lib/load-site-data.js";
import { renderJournalHtml } from "../src/lib/markdown.js";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = join(import.meta.dirname, "..");
const FIXTURE_DIR = join(PACKAGE_DIR, "..", "atlas", "test", "fixtures", "multi-residency");

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ATLAS_SITE_CHAIN_DIR: FIXTURE_DIR
  };
}

describe("build output", () => {
  it("renders journal markdown to HTML without raw heading syntax", () => {
    const html = renderJournalHtml("## Title\n\nHello");
    expect(html).not.toContain("## Title");
    expect(html).toContain("<h2>");
    expect(html).toContain("Hello");
  });

  it("wraps plain-text fixture journals in paragraph markup", async () => {
    const data = await loadSiteData(fixtureEnv());
    for (const journal of data.journals) {
      expect(journal.html).toMatch(/<p>/);
    }
  });

  it("produces expected static files after astro build", async () => {
    await execFileAsync("pnpm", ["build"], {
      cwd: PACKAGE_DIR,
      env: fixtureEnv()
    });

    const dist = join(PACKAGE_DIR, "dist");
    await access(join(dist, "index.html"));
    await access(join(dist, "journey", "index.html"));
    await access(join(dist, "journals", "index.html"));
    await access(join(dist, "soul", "index.html"));

    const data = await loadSiteData(fixtureEnv());
    for (const record of data.records) {
      await access(join(dist, "soul", record.cid, "index.html"));
    }
    for (const journal of data.journals) {
      await access(join(dist, "journals", journal.cid, "index.html"));
    }
  }, 120_000);
});
