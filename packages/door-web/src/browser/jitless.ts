import { config } from "zod";

/**
 * Zod's schema compiler uses `new Function`. The porch CSP is `script-src 'self'`,
 * so that probe would log a violation on every page load. Call this before any
 * schema is created.
 */
config({ jitless: true });
