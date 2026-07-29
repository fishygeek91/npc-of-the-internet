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
 * Commit cosign passes through after the same auth verify (same instance required post-depart).
 *
 * Auth/signature checks run via {@link Door.verifyCosignRequest} **before** any review-gate
 * Discord side effects so unauthenticated requests cannot post attacker text to the host channel.
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
   * Verify session binding + request signature first; on review, collect operator
   * decisions (timeout → rejected); then run Door cosign.
   */
  override async cosign(request: CosignRequest): Promise<CosignResponse> {
    this.verifyCosignRequest(request);
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
