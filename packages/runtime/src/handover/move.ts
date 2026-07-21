import type { Brain } from "../brain/types.js";
import type { TranscriptSource } from "../distill/types.js";
import { Session, type DepartResult, type SessionOptions } from "../session/session.js";
import type { DoorConnection } from "../session/types.js";

/** Options for {@link move}. */
export type MoveOptions = {
  /** Live session at the current door. */
  session: Session;
  transcript: TranscriptSource;
  journalDir: string;
  nextDoor: DoorConnection;
  nextDoorId: string;
  /** Options forwarded to {@link Session.start} at the next door (store/brain/keyring/timer/clock/doorPublicKeys). */
  arrive: Omit<SessionOptions, "door" | "doorId">;
  farewell?: string;
  /** Brain for depart distill/journal override. */
  brain?: Brain;
};

/** Result of {@link move}. */
export type MoveResult = {
  depart: DepartResult;
  /** New session at the next door. */
  session: Session;
};

/**
 * End residency at the current door, then begin residency at the next door.
 * No Door session traffic is accepted on the departed session during the travel gap.
 */
export async function move(options: MoveOptions): Promise<MoveResult> {
  const depart = await options.session.depart({
    transcript: options.transcript,
    journalDir: options.journalDir,
    toDoorId: options.nextDoorId,
    ...(options.farewell !== undefined ? { farewell: options.farewell } : {}),
    ...(options.brain !== undefined ? { brain: options.brain } : {})
  });

  const session = await Session.start({
    ...options.arrive,
    door: options.nextDoor,
    doorId: options.nextDoorId
  });

  return { depart, session };
}
