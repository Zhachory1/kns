/**
 * Message framing for MCP over stdio.
 *
 * Two framings exist in the wild: `Content-Length` headers (LSP style) and plain
 * newline-delimited JSON. ZBrain accepts either on input and emits `Content-Length`,
 * and other servers emit newlines, so the reader accepts both and the writer uses the
 * more explicit of the two.
 *
 * Framing is separated from transport so it can be tested exhaustively — including
 * split-mid-header and split-mid-body chunks, which are the cases that break naive
 * implementations under real pipe pressure.
 *
 * @module
 */

/** Largest message accepted, mirroring the server-side cap. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * Encode a JSON-RPC message with a `Content-Length` header.
 *
 * @param message - Value to serialise.
 * @returns The framed message, ready to write to a stream.
 */
export function encodeMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/**
 * Incremental reader that turns a byte stream into message bodies.
 *
 * Instances are stateful: feed every chunk in arrival order.
 */
export class MessageFramer {
  /** Bytes received but not yet forming a complete message. */
  #buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed a chunk and take whatever complete messages it produced.
   *
   * @param chunk - Bytes as received from the stream.
   * @returns Complete message bodies, in order. Empty when more bytes are needed.
   * @throws {RangeError} When a declared message exceeds {@link MAX_MESSAGE_BYTES}.
   */
  push(chunk: Buffer | string): string[] {
    this.#buffer = Buffer.concat([
      this.#buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
    ]);

    const messages: string[] = [];
    for (;;) {
      const message = this.#take();
      if (message === null) break;
      if (message !== '') messages.push(message);
    }
    return messages;
  }

  /** Bytes buffered so far, exposed for tests and diagnostics. */
  get pending(): number {
    return this.#buffer.length;
  }

  /**
   * Take one message from the buffer.
   *
   * @returns The message body, an empty string for a blank line to skip, or null when
   *          the buffer does not yet hold a complete message.
   */
  #take(): string | null {
    if (this.#buffer.length === 0) return null;

    const header = this.#buffer.subarray(0, 32).toString('ascii');
    if (/^content-length:/i.test(header)) {
      const separator = this.#buffer.indexOf('\r\n\r\n');
      if (separator < 0) return null;

      const headerText = this.#buffer.subarray(0, separator).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(headerText);
      const length = match?.[1] === undefined ? Number.NaN : Number(match[1]);
      const start = separator + 4;

      if (!Number.isFinite(length)) {
        // Unparseable header: drop it and resynchronise rather than stalling forever.
        this.#buffer = this.#buffer.subarray(start);
        return '';
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.#buffer = Buffer.alloc(0);
        throw new RangeError(`message of ${length} bytes exceeds the ${MAX_MESSAGE_BYTES} byte cap`);
      }
      if (this.#buffer.length < start + length) return null;

      const body = this.#buffer.subarray(start, start + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(start + length);
      return body;
    }

    const newline = this.#buffer.indexOf(0x0a);
    if (newline < 0) {
      if (this.#buffer.length > MAX_MESSAGE_BYTES) {
        this.#buffer = Buffer.alloc(0);
        throw new RangeError(`unterminated message exceeds the ${MAX_MESSAGE_BYTES} byte cap`);
      }
      return null;
    }

    const line = this.#buffer.subarray(0, newline).toString('utf8').trim();
    this.#buffer = this.#buffer.subarray(newline + 1);
    return line;
  }
}
