import "./jitless.js";
import { installChainWorker, isDedicatedWorker } from "./chain-worker.js";
import { rememberPageScript } from "./incremental-chain.js";
import { fetchChain, lineAwaitsEpoch, verifyReaction, verifyText } from "./verify-porch.js";

/**
 * Classic-script entry for the porch page. Bundled to `public/verify.js`.
 * The same file is the blob worker: a dedicated worker only installs the verifier.
 * The page calls `globalThis.WandererVerify` and never imports Node.
 */
if (isDedicatedWorker(globalThis)) {
  installChainWorker(globalThis);
} else {
  rememberPageScript(globalThis);
  Object.assign(globalThis, {
    WandererVerify: { fetchChain, verifyText, verifyReaction, lineAwaitsEpoch }
  });
}
