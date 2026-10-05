import {
  Door,
  DoorError,
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
 * Auth/signature/shard-count checks run via {@link Door.verifyCosignRequest} **before**
 * any review-gate Discord side effects so unauthenticated or oversized requests cannot
 * post attacker text to the host channel.
 *
 * Only one review may be in flight: an identical retry (same signed request) joins the
 * pending review; any other review request is rejected with `review_pending` instead of
 * re-posting shards and orphaning the first caller.
 *
 * Optional outbound listener fires after successful verification so adapters can
 * relay WS outbounds to Discord without re-entering {@link handleOutbound}.
 */
export class ReviewGatedDoor extends Door {
  private readonly reviewGate: ReviewGate;
  private outboundListener: ((frame: OutboundFrame) => void) | null = null;
  private inFlightReview: { sig: string; result: Promise<CosignResponse> } | null = null;

  constructor(options: DoorOptions, reviewGate: ReviewGate) {
    super(options);
    this.reviewGate = reviewGate;
  }

  /** Register a listener invoked after a verified outbound frame is accepted. */
  setOutboundListener(listener: ((frame: OutboundFrame) => void) | null): void {
    this.outboundListener = listener;
  }

  /**
   * Verify freshness, session binding, and request signature first; on review, collect
   * operator decisions (timeout → rejected); then run Door cosign.
   */
  override async cosign(request: CosignRequest): Promise<CosignResponse> {
    this.verifyCosignRequest(request);
    if (request.phase !== "review") {
      return super.cosign(request);
    }

    const inFlight = this.inFlightReview;
    if (inFlight !== null) {
      if (inFlight.sig === request.sig) {
        return inFlight.result;
      }
      throw DoorError.fromCode(
        "review_pending",
        "review_pending: a cosign review is already in progress"
      );
    }

    const result = (async (): Promise<CosignResponse> => {
      await this.reviewGate.collect(request.shards);
      return super.cosign(request);
    })();
    this.inFlightReview = { sig: request.sig, result };
    try {
      return await result;
    } finally {
      if (this.inFlightReview?.result === result) {
        this.inFlightReview = null;
      }
    }
  }

  override handleOutbound(frame: OutboundFrame): void {
    super.handleOutbound(frame);
    this.outboundListener?.(frame);
  }
}
