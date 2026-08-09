import { OSP_SPEC_V02 } from "@npc/osp-core";

/**
 * OSP spec version for new Ghost runtime chain writes (#119 cutover).
 * Historical fixture chains may still use osp/0.1; verifyChain accepts either
 * homogeneous version.
 */
export const RUNTIME_OSP_SPEC = OSP_SPEC_V02;
