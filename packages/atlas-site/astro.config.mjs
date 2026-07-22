import process from "node:process";

import { defineConfig } from "astro/config";

/** @type {import('astro').AstroUserConfig} */
export default defineConfig({
  output: "static",
  base: process.env.ATLAS_SITE_BASE ?? "/",
  outDir: "dist"
});
