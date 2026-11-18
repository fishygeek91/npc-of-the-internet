import "./jitless.js";
import { fetchChain, lineAwaitsEpoch, verifyReaction, verifyText } from "./verify-porch.js";

/**
 * Classic-script entry for the porch page. Bundled to `public/verify.js`.
 * The page calls `globalThis.WandererVerify` and never imports Node.
 */
Object.assign(globalThis, {
  WandererVerify: { fetchChain, verifyText, verifyReaction, lineAwaitsEpoch }
});
