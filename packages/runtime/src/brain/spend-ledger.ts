import { open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import {
  assertCanonicalIsoUtc,
  CANONICAL_ISO_UTC_MS,
  DECIMAL_MICROS,
  monthlyPeriodStart,
  nextMonthlyPeriodStart,
  parseDecimalMicros
} from "./budget-policy.js";
import { BrainError } from "./errors.js";

/**
 * Append-only spend journal (`spend.jsonl`).
 *
 * This is off the soulchain on purpose: public `transaction` records are T7.7,
 * and treasury-lite only needs the brain to know what it has already spent.
 * The file is the state. Totals are replayed; nothing mutable is stored beside it.
 * A missing file is not zero spend unless `createIfMissing` is set
 * (`NPC_BUDGET_LEDGER_INIT=1`, a one-shot against an absolute path). A corrupt
 * line or a torn tail is untrusted and is left untouched — the caller fails
 * closed (no further model calls) until an
 * operator removes the bad tail. A crash after a provider response and before
 * the matching line is fsynced can under-count that one call; the prepaid key
 * (ops, follow-up) is the hard wall for that window.
 */

const spendLineSchema = z
  .object({
    kind: z.literal("spend"),
    ts: z.string().regex(CANONICAL_ISO_UTC_MS),
    tier: z.string().min(1),
    model: z.string().min(1),
    tokens_in: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tokens_out: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    est_cost: z.string().regex(DECIMAL_MICROS)
  })
  .strict();

const providerExhaustedLineSchema = z
  .object({
    kind: z.literal("provider_exhausted"),
    ts: z.string().regex(CANONICAL_ISO_UTC_MS),
    tier: z.string().min(1),
    model: z.string().min(1)
  })
  .strict();

const unknownSpendLineSchema = z
  .object({
    kind: z.literal("unknown_spend"),
    ts: z.string().regex(CANONICAL_ISO_UTC_MS),
    tier: z.string().min(1),
    model: z.string().min(1)
  })
  .strict();

const wakeLineSchema = z
  .object({
    kind: z.literal("wake"),
    ts: z.string().regex(CANONICAL_ISO_UTC_MS),
    reason: z.enum(["operator", "budget_raised", "period_reset"])
  })
  .strict();

const ledgerLineSchema = z.discriminatedUnion("kind", [
  spendLineSchema,
  providerExhaustedLineSchema,
  unknownSpendLineSchema,
  wakeLineSchema
]);

/** One JSONL line. Field names match the on-disk journal (snake_case, like record bodies). */
export type LedgerEvent = z.infer<typeof ledgerLineSchema>;

/** Why a journal cannot be summed. Callers treat every reason as unknown spend. */
export type LedgerUntrustedReason = "missing" | "corrupt" | "torn" | "unreadable";

/** Replay of one UTC month, or a refusal to guess. */
export type SpendView =
  | {
      trusted: true;
      spentMicros: bigint;
      providerExhausted: boolean;
      /** A completion whose token counts could not be priced. Cleared by a later wake in-period. */
      unknownSpend: boolean;
    }
  | { trusted: false; reason: LedgerUntrustedReason };

export type SpendLedgerOptions = {
  path: string;
  /**
   * Create an empty journal when the path is missing.
   * Leave false in production after the first boot so a deleted file fails closed.
   */
  createIfMissing: boolean;
};

/**
 * Spend journal opened from disk. Not safe for concurrent appends from two
 * processes; {@link BudgetedBrain} serializes callers in-process.
 */
export class SpendLedger {
  private readonly path: string;
  private events: LedgerEvent[] = [];
  private untrusted: LedgerUntrustedReason | null = null;

  private constructor(path: string) {
    this.path = path;
  }

  /**
   * Open a journal. Does not throw for a missing, torn, or corrupt file — those
   * come back as an untrusted ledger so the process can stay up and refuse calls.
   *
   * @param options - Path and whether a missing file may be created empty.
   */
  static async open(options: SpendLedgerOptions): Promise<SpendLedger> {
    if (options.path.trim() === "" || options.path.includes("\0")) {
      throw new BrainError("NPC_BUDGET_LEDGER_PATH is required but not set", "invalid_config", {
        envVar: "NPC_BUDGET_LEDGER_PATH"
      });
    }
    const ledger = new SpendLedger(options.path);
    await ledger.load(options.createIfMissing);
    return ledger;
  }

  /**
   * Sum `spend` lines in the UTC month containing `periodAnchor`, and fold
   * provider-exhausted / unknown-spend / wake flags in file order.
   * File order is the order lines were appended; a skewed clock does not reorder them.
   * Events outside that month do not count (a new month clears the latch).
   *
   * @param periodAnchor - Canonical timestamp; the month is derived from it.
   */
  replay(periodAnchor: string): SpendView {
    if (this.untrusted !== null) {
      return { trusted: false, reason: this.untrusted };
    }
    const periodStart = monthlyPeriodStart(periodAnchor);
    const periodEnd = nextMonthlyPeriodStart(periodStart);

    let spentMicros = 0n;
    let providerExhausted = false;
    let unknownSpend = false;
    for (const event of this.events) {
      if (event.ts < periodStart || event.ts >= periodEnd) {
        continue;
      }
      switch (event.kind) {
        case "spend":
          spentMicros += parseDecimalMicros(event.est_cost);
          break;
        case "provider_exhausted":
          providerExhausted = true;
          break;
        case "unknown_spend":
          unknownSpend = true;
          break;
        case "wake":
          providerExhausted = false;
          unknownSpend = false;
          break;
        default: {
          const unreachable: never = event;
          void unreachable;
          return { trusted: false, reason: "corrupt" };
        }
      }
    }
    return { trusted: true, spentMicros, providerExhausted, unknownSpend };
  }

  /**
   * Append one event and fsync it. Refuses when the journal is untrusted.
   * On a write failure the in-memory copy is unchanged and the journal becomes
   * untrusted for the rest of this process.
   *
   * @param event - Spend, provider exhaustion, unknown spend, or wake.
   */
  async append(event: LedgerEvent): Promise<void> {
    if (this.untrusted !== null) {
      throw new BrainError("spend ledger is untrusted", "credit_exhausted", {
        envVar: "NPC_BUDGET_LEDGER_PATH"
      });
    }
    assertCanonicalIsoUtc(event.ts);
    const payload = `${serializeLedgerEvent(event)}\n`;
    try {
      const handle = await open(this.path, "a");
      try {
        await handle.write(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      this.untrusted = "unreadable";
      if (error instanceof BrainError) {
        throw error;
      }
      throw new BrainError("failed to append spend ledger", "credit_exhausted", {
        envVar: "NPC_BUDGET_LEDGER_PATH"
      });
    }
    this.events.push(event);
  }

  private async load(createIfMissing: boolean): Promise<void> {
    const read = await readLedgerBytes(this.path);
    if (read.ok) {
      await this.acceptBytes(read.bytes);
      return;
    }
    if (read.reason !== "missing" || !createIfMissing) {
      this.untrusted = read.reason;
      return;
    }
    const created = await createEmpty(this.path);
    if (created === "failed") {
      this.untrusted = "unreadable";
      return;
    }
    if (created === "created") {
      return;
    }
    const again = await readLedgerBytes(this.path);
    if (!again.ok) {
      this.untrusted = "unreadable";
      return;
    }
    await this.acceptBytes(again.bytes);
  }

  private async acceptBytes(bytes: Buffer): Promise<void> {
    const text = decodeUtf8(bytes);
    if (text === null) {
      this.untrusted = "corrupt";
      return;
    }
    const parsed = parseDocument(text);
    if (parsed.status !== "ok") {
      this.untrusted = parsed.status;
      return;
    }
    this.events = parsed.events;
    if (!parsed.needsTrailingNewline) {
      return;
    }
    try {
      const handle = await open(this.path, "a");
      try {
        await handle.write("\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      this.untrusted = "unreadable";
      this.events = [];
    }
  }
}

function serializeLedgerEvent(event: LedgerEvent): string {
  switch (event.kind) {
    case "spend":
      return JSON.stringify({
        kind: event.kind,
        ts: event.ts,
        tier: event.tier,
        model: event.model,
        tokens_in: event.tokens_in,
        tokens_out: event.tokens_out,
        est_cost: event.est_cost
      });
    case "provider_exhausted":
    case "unknown_spend":
      return JSON.stringify({
        kind: event.kind,
        ts: event.ts,
        tier: event.tier,
        model: event.model
      });
    case "wake":
      return JSON.stringify({
        kind: event.kind,
        ts: event.ts,
        reason: event.reason
      });
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function parseLedgerLine(line: string): LedgerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = ledgerLineSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  try {
    assertCanonicalIsoUtc(parsed.data.ts);
  } catch {
    return null;
  }
  return parsed.data;
}

function parseDocument(
  text: string
):
  | { status: "ok"; events: LedgerEvent[]; needsTrailingNewline: boolean }
  | { status: "corrupt" | "torn" } {
  if (text === "") {
    return { status: "ok", events: [], needsTrailingNewline: false };
  }
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsWithNewline) {
    lines.pop();
  }
  const events: LedgerEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line === "") {
      return { status: "corrupt" };
    }
    const event = parseLedgerLine(line);
    const isLast = index === lines.length - 1;
    if (event === null) {
      if (isLast && !endsWithNewline) {
        return { status: "torn" };
      }
      return { status: "corrupt" };
    }
    events.push(event);
  }
  return { status: "ok", events, needsTrailingNewline: !endsWithNewline };
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readLedgerBytes(
  path: string
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: "missing" | "unreadable" }> {
  try {
    return { ok: true, bytes: await readFile(path) };
  } catch (error: unknown) {
    if (nodeCode(error) === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "unreadable" };
  }
}

async function createEmpty(path: string): Promise<"created" | "exists" | "failed"> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx");
  } catch (error: unknown) {
    if (nodeCode(error) === "EEXIST") {
      return "exists";
    }
    return "failed";
  }
  try {
    await handle.close();
    await fsyncParentDirectory(path);
    return "created";
  } catch {
    try {
      await unlink(path);
    } catch {
      // The empty file may remain. This open still fails closed.
    }
    return "failed";
  }
}

/**
 * Make the new directory entry durable. A platform that refuses to fsync a
 * directory throws; the caller then treats the journal as unreadable.
 */
async function fsyncParentDirectory(filePath: string): Promise<void> {
  const handle = await open(dirname(filePath), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function nodeCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
