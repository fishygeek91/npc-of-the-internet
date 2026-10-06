import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attestSigningPayload,
  DOOR_PROTOCOL_VERSION,
  outboundSigningPayload,
  sessionBindSigningPayload,
  type AttestRequest,
  type OutboundFrame,
  type SessionBindParams
} from "@npc/door-sdk";
import {
  canonicalize,
  encodePublicKey,
  encodeSignature,
  generateKeypair,
  sign,
  type Ed25519Keypair
} from "@npc/osp-core";
import pino from "pino";

import type { WebDoorConfig } from "../src/config.js";

export const silentLogger = pino({ level: "silent" });

const tempDirs: string[] = [];

/** Remove temp dirs created by {@link writeDoorKey}. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a fresh door private key (32 raw bytes) to a temp file. */
export function writeDoorKey(): string {
  const dir = mkdtempSync(join(tmpdir(), "door-web-key-"));
  tempDirs.push(dir);
  const path = join(dir, "door.key");
  writeFileSync(path, Buffer.from(generateKeypair().privateKey));
  return path;
}

/** Config for tests: ephemeral ports on loopback, no witness, no atlas. */
export function testConfig(
  soul: Ed25519Keypair,
  overrides: Partial<WebDoorConfig> = {}
): WebDoorConfig {
  return {
    doorId: "web:test",
    doorKeyPath: writeDoorKey(),
    soulPublicKey: soul.publicKey,
    doorHttpHost: "127.0.0.1",
    doorHttpPort: 0,
    publicHost: "127.0.0.1",
    publicPort: 0,
    communityName: "Test porch",
    communityDescription: "A porch for tests.",
    maxClients: 10,
    globalPerMinute: 30,
    trustProxy: false,
    ...overrides
  };
}

/** Canonical OSP attestation core bound to `(door_id, epoch, kind)`. */
function attestCore(kind: AttestRequest["kind"], epoch: number, doorId: string): string {
  return new TextDecoder().decode(
    canonicalize({
      spec: "osp/0.2",
      seq: 1,
      prev: "bafyprev",
      type: "attestation",
      body: { kind, door_id: doorId, epoch },
      residency: `door:${doorId}/epoch:${String(epoch)}`
    })
  );
}

/** A real signed arrival (soul key) or departure (session key) attest request. */
export function signedAttest(args: {
  kind: "arrival" | "departure";
  doorId: string;
  epoch: number;
  soul: Ed25519Keypair;
  session: Ed25519Keypair;
}): AttestRequest {
  const fields: Omit<AttestRequest, "sig"> = {
    protocol_version: DOOR_PROTOCOL_VERSION,
    door_id: args.doorId,
    epoch: args.epoch,
    kind: args.kind,
    core: attestCore(args.kind, args.epoch, args.doorId),
    session_pubkey: encodePublicKey(args.session.publicKey),
    issued_at: new Date().toISOString()
  };
  const key = args.kind === "arrival" ? args.soul.privateKey : args.session.privateKey;
  return { ...fields, sig: encodeSignature(sign(attestSigningPayload(fields), key)) };
}

/** Session binding proof for `WS /door/session`. */
export function bindParams(
  session: Ed25519Keypair,
  doorId: string,
  epoch: number
): SessionBindParams {
  const sessionPubkey = encodePublicKey(session.publicKey);
  const payload = sessionBindSigningPayload({
    door_id: doorId,
    epoch,
    session_pubkey: sessionPubkey
  });
  return {
    door_id: doorId,
    epoch,
    session_pubkey: sessionPubkey,
    session_sig: encodeSignature(sign(payload, session.privateKey))
  };
}

/** A session-signed outbound frame. */
export function signedOutbound(args: {
  session: Ed25519Keypair;
  doorId: string;
  epoch: number;
  msgId: string;
  body: OutboundFrame["body"];
}): OutboundFrame {
  const unsigned: Omit<OutboundFrame, "sig"> = {
    type: "outbound",
    door_id: args.doorId,
    epoch: args.epoch,
    msg_id: args.msgId,
    issued_at: new Date().toISOString(),
    body: args.body
  };
  return {
    ...unsigned,
    sig: encodeSignature(sign(outboundSigningPayload(unsigned), args.session.privateKey))
  };
}

/** POST JSON and return status + parsed body. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
  };
}

/** One parsed Server-Sent Event. */
export type SseEvent = { event: string; data: unknown };

/** Minimal SSE reader over fetch for tests. */
export class SseReader {
  readonly status: number;
  private readonly events: SseEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly controller: AbortController;

  private constructor(status: number, controller: AbortController) {
    this.status = status;
    this.controller = controller;
  }

  /** Open `GET url`; resolves once response headers arrive. */
  static async open(url: string): Promise<SseReader> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = new SseReader(response.status, controller);
    if (response.body !== null && response.ok) {
      void reader.pump(response.body);
    } else {
      await response.body?.cancel();
    }
    return reader;
  }

  /** Wait for the first not-yet-consumed event matching `event` (and `match`). */
  async next(
    event: string,
    match: (data: unknown) => boolean = () => true,
    timeoutMs = 3000
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.events.findIndex(
        (candidate) => candidate.event === event && match(candidate.data)
      );
      if (index >= 0) {
        const [found] = this.events.splice(index, 1);
        return found?.data;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for SSE event ${event}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.controller.abort();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.parseBlock(block);
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted.
    }
  }

  private parseBlock(block: string): void {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }
    if (data === "") {
      return;
    }
    this.events.push({ event, data: JSON.parse(data) as unknown });
    for (const wake of this.waiters.splice(0)) {
      wake();
    }
  }
}
