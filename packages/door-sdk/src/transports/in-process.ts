import type { Door } from "../door.js";
import type {
  AttestRequest,
  AttestResponse,
  CosignRequest,
  CosignResponse,
  DoorConnection,
  HeartbeatRequest,
  HeartbeatResponse,
  HelloResponse,
  OutboundFrame
} from "../schemas.js";

/**
 * In-process `DoorConnection` adapter for tests and same-process Session wiring.
 * Delegates attest, heartbeat, and cosign to the underlying `Door` core.
 */
export class InProcessDoorConnection implements DoorConnection {
  constructor(private readonly door: Door) {}

  /** `POST /door/attest` — delegate to Door core. */
  attest(req: AttestRequest): Promise<AttestResponse> {
    return this.door.attest(req);
  }

  /** `POST /door/heartbeat` — delegate to Door core. */
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.door.heartbeat(req);
  }

  /** `POST /door/cosign` — delegate to Door core. */
  cosign(req: CosignRequest): Promise<CosignResponse> {
    return this.door.cosign(req);
  }

  /** `POST /door/hello` — exposed for transport parity tests. */
  hello(req: unknown): Promise<HelloResponse> {
    return this.door.hello(req);
  }

  /** Verify an outbound WebSocket frame against the active session. */
  verifyOutbound(frame: OutboundFrame): boolean {
    return this.door.verifyOutbound(frame);
  }

  /** Active session public key after arrival attest, if any. */
  getActiveSessionPubkey(): string | null {
    return this.door.getActiveSessionPubkey();
  }

  /** Underlying Door core for advanced test assertions. */
  get doorCore(): Door {
    return this.door;
  }
}
