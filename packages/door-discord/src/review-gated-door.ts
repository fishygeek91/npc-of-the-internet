import {
  Door,
  type CosignRequest,
  type CosignResponse,
  type DoorOptions,
  type OutboundFrame
} from "@npc/door-sdk";

import type { ReviewGate } from "./review-gate.js";

/**
 * Door subclass that awaits Discord host review before the sync `decideShard` phase.
 * Commit cosign passes through unchanged (same instance required post-depart).
 *
 * Optional outbound listener fires after successful verification so adapters can
 * relay WS outbounds to Discord without re-entering {@link handleOutbound}.
 */
export class ReviewGatedDoor extends Door {
  private readonly reviewGate: ReviewGate;
  private outboundListener: ((frame: OutboundFrame) => void) | null = null;

  constructor(options: DoorOptions, reviewGate: ReviewGate) {
    super(options);
    this.reviewGate = reviewGate;
  }

  /** Register a listener invoked after a verified outbound frame is accepted. */
  setOutboundListener(listener: ((frame: OutboundFrame) => void) | null): void {
    this.outboundListener = listener;
  }

  /**
   * On review: collect operator decisions (timeout → rejected), then run Door cosign.
   * On commit: delegate immediately.
   */
  override async cosign(request: CosignRequest): Promise<CosignResponse> {
    if (request.phase === "review") {
      await this.reviewGate.collect(request.shards);
    }
    return super.cosign(request);
  }

  override handleOutbound(frame: OutboundFrame): void {
    super.handleOutbound(frame);
    this.outboundListener?.(frame);
  }
}
