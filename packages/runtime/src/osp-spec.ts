import { OSP_SPEC_V01, OSP_SPEC_V02, type SoulStore } from "@npc/osp-core";

/**
 * OSP spec version for new Ghost runtime chain writes (#119 cutover).
 * Historical fixture chains may still use osp/0.1 for read-only verify/compose;
 * runtime appends require a homogeneous {@link RUNTIME_OSP_SPEC} chain.
 */
export const RUNTIME_OSP_SPEC = OSP_SPEC_V02;

/**
 * Thrown when Ghost runtime refuses to append because the chain is still osp/0.1.
 * Migrate with `osp migrate --to osp/0.2` before starting (see ops/RUNBOOK.ghost.md).
 */
export class SpecCutoverError extends Error {
  readonly code = "SPEC_CUTOVER_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "SpecCutoverError";
  }
}

/**
 * Refuse runtime writes when the store's chain is not homogeneous {@link RUNTIME_OSP_SPEC}.
 *
 * Must run before any append so an osp/0.1 chain is never poisoned with a mixed-spec
 * record. Empty stores (no genesis yet) are allowed — init/writers create V02 genesis.
 */
export async function assertRuntimeWritableChain(store: SoulStore): Promise<void> {
  for await (const record of store.iterate()) {
    if (record.spec === RUNTIME_OSP_SPEC) {
      return;
    }
    if (record.spec === OSP_SPEC_V01) {
      throw new SpecCutoverError(
        `soulchain is ${OSP_SPEC_V01}; Ghost runtime writes ${RUNTIME_OSP_SPEC}. ` +
          `Run \`osp migrate --to osp/0.2 <dir>\` before starting ` +
          `(see ops/RUNBOOK.ghost.md § osp/0.2 cutover). Refusing to append.`
      );
    }
    throw new SpecCutoverError(
      `soulchain has unsupported spec ${record.spec}; Ghost runtime writes ${RUNTIME_OSP_SPEC}. ` +
        `Refusing to append.`
    );
  }
}
