/**
 * A response body or `Content-Length` exceeded {@link readBodyCapped}'s cap.
 * Only `maxBytes` is attached — no response bytes, headers, or request fields —
 * so a caller maps this with `instanceof` onto its own error type.
 */
export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super("response body exceeds cap");
    this.name = "ResponseTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Read `response.body` up to `maxBytes` bytes.
 *
 * A `Content-Length` above `maxBytes` fails before the body is kept. Otherwise
 * the body is streamed and, once the running total exceeds `maxBytes`, `abort`
 * is signalled and the reader is cancelled. Exactly `maxBytes` is returned.
 * A missing body is an empty buffer. Pass the controller combined into the
 * fetch signal so cancelling the body also drops the socket.
 *
 * @throws {ResponseTooLargeError} when the body or `Content-Length` is over the cap.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
  abort?: AbortController
): Promise<Uint8Array> {
  if (contentLengthExceeds(response, maxBytes)) {
    await cancelCappedBody(response, undefined, abort);
    throw new ResponseTooLargeError(maxBytes);
  }

  const body = response.body;
  if (body === null) {
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const value = next.value;
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.length = 0;
        await cancelCappedBody(response, reader, abort);
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw error;
    }
    await cancelCappedBody(response, reader, abort);
    throw error;
  }

  return Buffer.concat(chunks);
}

/** True when Content-Length is a byte count strictly above `maxBytes`. Non-digits are ignored. */
function contentLengthExceeds(response: Response, maxBytes: number): boolean {
  const header = response.headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/u.test(header)) {
    return false;
  }
  const value = Number(header);
  return !Number.isFinite(value) || value > maxBytes;
}

/**
 * Abort the fetch and cancel the body. Cancel failures are swallowed so callers
 * see {@link ResponseTooLargeError} rather than a socket error.
 */
async function cancelCappedBody(
  response: Response,
  reader: { cancel: () => Promise<void> } | undefined,
  abort: AbortController | undefined
): Promise<void> {
  if (abort !== undefined) {
    abort.abort();
  }
  try {
    if (reader !== undefined) {
      await reader.cancel();
      return;
    }
    if (response.body !== null) {
      await response.body.cancel();
    }
  } catch {
    // The peer may already have dropped the socket.
  }
}
