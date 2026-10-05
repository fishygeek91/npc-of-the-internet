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
 * Freshness/auth/signature/shard-count checks run **once, on receipt** via
 * {@link Door.verifyCosignRequest} — before any review-gate Discord side effects, so
 * stale, unauthenticated, or oversized requests cannot post attacker text to the host
 * channel. After the (possibly minutes-long) human review the request finishes through
 * {@link Door.cosignReceivedFresh}, which re-verifies session/epoch/signature but not the
 * clock: a request that was fresh on receipt never turns `timestamp_stale` while a human
 * reviews it.
 *
 * Only one review may be in flight. Reviews are matched by {@link Door.cosignReviewKey}
 * (`epoch`, `session_pubkey`, sorted shard ids + texts — not `issued_at`/`sig`, which a
 * retrying Wanderer re-signs): an authenticated, fresh retry with the same key joins the
 * pending review; any other review request is rejected with `review_pending` instead of
 * re-posting shards and orphaning the first caller. Once the review completed, a matching
 * retry gets the stored signed response (base Door) instead of `epoch_closed`.
 *
 * Optional outbound listener fires after successful verification so adapters can
 * relay WS outbounds to Discord without re-entering {@link handleOutbound}.
 */
export class ReviewGatedDoor extends Door {
  private readonly reviewGate: ReviewGate;
  private outboundListener: ((frame: OutboundFrame) => void) | null = null;
  private inFlightReview: { key: string; result: Promise<CosignResponse> } | null = null;

  constructor(options: DoorOptions, reviewGate: ReviewGate) {
    super(options);
    this.reviewGate = reviewGate;
  }

  /** Register a listener invoked after a verified outbound frame is accepted. */
  setOutboundListener(listener: ((frame: OutboundFrame) => void) | null): void {
    this.outboundListener = listener;
  }

  /**
   * Verify freshness, session binding, and request signature first (once); on review,
   * collect operator decisions (timeout → rejected); then finish Door cosign without
   * re-checking the clock.
   */
  override async cosign(request: CosignRequest): Promise<CosignResponse> {
    this.verifyCosignRequest(request);
    if (request.phase !== "review" || this.isCosignReviewCompleted()) {
      // Commit, or an authenticated retry of the completed review (replayed by the Door).
      return this.cosignReceivedFresh(request);
    }

    const key = this.cosignReviewKey(request);
    const inFlight = this.inFlightReview;
    if (inFlight !== null) {
      if (inFlight.key === key) {
        return inFlight.result;
      }
      throw DoorError.fromCode(
        "review_pending",
        "review_pending: a cosign review is already in progress"
      );
    }

    const result = (async (): Promise<CosignResponse> => {
      await this.reviewGate.collect(request.shards);
      return this.cosignReceivedFresh(request);
    })();
    this.inFlightReview = { key, result };
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
