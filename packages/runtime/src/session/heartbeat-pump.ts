import {
  OSP_SPEC_V02,
  canonicalize,
  corePayload,
  encodePublicKey,
  encodeSignature,
  type CreateRecordFields,
  type SoulStore
} from "@npc/osp-core";

import type { Keyring, SessionSigner } from "../keyring/types.js";
import { POP_VERSION, sealRecord } from "./attest.js";
import { SessionError } from "./errors.js";
import {
  DOOR_PROTOCOL_VERSION,
  attestSigningPayload,
  type AttestRequest,
  type Clock,
  type DoorConnection,
  type HeartbeatRequest
} from "./types.js";

/** Session phase as observed at the start of a heartbeat attempt. */
export type HeartbeatPhase = "live" | "departing" | "departed";

/** Where a heartbeat failure occurred (Door call vs soulchain append). */
export type HeartbeatErrorStage = "door" | "append";

/** Stable collaborators for one residency's heartbeat attestations. */
export type HeartbeatPumpDeps = {
  readonly store: SoulStore;
  readonly door: DoorConnection;
  readonly clock: Clock;
  readonly sessionSigner: SessionSigner;
  readonly keyring: Keyring;
  readonly doorId: string;
  readonly epoch: number;
  readonly residency: string;
  readonly sessionPublicKey: Uint8Array;
  notifyHeartbeatError(error: unknown, stage: HeartbeatErrorStage): void;
};

/**
 * Door heartbeat ping plus the cosigned heartbeat attestation append.
 *
 * Session still owns the timer: `stop` must clear it in the same turn it leaves
 * `live`, before any await. This pump only runs the body of one tick.
 * The seq advances after the Door accepts the ping and before attest, so a lost
 * attest response does not reuse the seq.
 */
export class HeartbeatPump {
  private seq = 0;

  constructor(private readonly deps: HeartbeatPumpDeps) {}

  /**
   * Run one heartbeat when `phase` is `live`.
   * No-op for any other phase (the tick was queued, then the residency stopped).
   */
  async run(phase: HeartbeatPhase): Promise<void> {
    if (phase !== "live") {
      return;
    }

    const head = await this.deps.store.head();
    if (head === null) {
      throw new SessionError("heartbeat: store has no head");
    }

    const seq = this.seq + 1;
    const issuedAt = this.deps.clock.now();
    const sessionPubkeyEncoded = encodePublicKey(this.deps.sessionPublicKey);

    const unsignedHeartbeat: Omit<HeartbeatRequest, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: this.deps.doorId,
      epoch: this.deps.epoch,
      session_pubkey: sessionPubkeyEncoded,
      seq,
      issued_at: issuedAt
    };
    const heartbeatSig = encodeSignature(
      this.deps.sessionSigner.sign(canonicalize(unsignedHeartbeat))
    );

    try {
      await this.deps.door.heartbeat({
        ...unsignedHeartbeat,
        sig: heartbeatSig
      });
    } catch (error) {
      this.deps.notifyHeartbeatError(error, "door");
      throw error;
    }

    this.seq = seq;

    const heartbeatBody = {
      kind: "heartbeat" as const,
      pop_version: POP_VERSION,
      door_id: this.deps.doorId,
      epoch: this.deps.epoch,
      session_pubkey: sessionPubkeyEncoded,
      at: this.deps.clock.now()
    };

    await this.appendHeartbeatAttestation({
      body: heartbeatBody,
      seq: head.seq + 1,
      prev: head.cid
    });
  }

  /**
   * Heartbeat-only attest+append with stage-tagged errors for `notifyHeartbeatError`.
   */
  private async appendHeartbeatAttestation(params: {
    body: CreateRecordFields["body"];
    seq: number;
    prev: string;
  }): Promise<void> {
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC_V02,
          seq: params.seq,
          prev: params.prev,
          type: "attestation",
          body: params.body,
          residency: this.deps.residency
        })
      )
    );

    const issuedAt = this.deps.clock.now();
    const sessionPubkeyEncoded = encodePublicKey(this.deps.sessionPublicKey);

    const unsignedAttest: Omit<AttestRequest, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: this.deps.doorId,
      epoch: this.deps.epoch,
      kind: "heartbeat",
      core,
      session_pubkey: sessionPubkeyEncoded,
      issued_at: issuedAt
    };

    const attestSig = encodeSignature(
      this.deps.sessionSigner.sign(attestSigningPayload(unsignedAttest))
    );

    let doorCosig: string;
    try {
      const attestResponse = await this.deps.door.attest({
        ...unsignedAttest,
        sig: attestSig
      });
      doorCosig = attestResponse.door_cosig;
    } catch (error) {
      this.deps.notifyHeartbeatError(error, "door");
      throw error;
    }

    const { record } = await sealRecord(this.deps.keyring, {
      seq: params.seq,
      prev: params.prev,
      type: "attestation",
      body: params.body,
      residency: this.deps.residency,
      cosigners: [doorCosig]
    });

    try {
      await this.deps.store.append(record);
    } catch (error) {
      this.deps.notifyHeartbeatError(error, "append");
      throw error;
    }
  }
}
