/**
 * SIP message framing for connection-oriented transports (RFC 3261 §7.5 / §18.2).
 *
 * Over TCP/TLS a stream carries a sequence of messages with no delimiter: the
 * headers end at CRLF CRLF and the body is exactly Content-Length bytes. This
 * decoder is deliberately allocation-light and tolerates the real-world cases
 * that break naive splitting — a message spread across chunks, two messages in
 * one chunk, and a body that itself contains CRLF CRLF.
 */

export class SipMessageStream {
  private buffer = Buffer.alloc(0);

  /** Feed bytes, returning every complete message now available. */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        // A response/request without a body still needs its terminator; guard against
        // a peer that never sends one by refusing to grow without bound.
        if (this.buffer.length > 65536) this.buffer = Buffer.alloc(0);
        return messages;
      }
      const headers = this.buffer.subarray(0, headerEnd).toString('utf8');
      const bodyLength = contentLengthOf(headers);
      if (bodyLength === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const total = headerEnd + 4 + bodyLength;
      if (this.buffer.length < total) return messages; // body still arriving
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8');
      messages.push(`${headers}\r\n\r\n${body}`);
      this.buffer = this.buffer.subarray(total);
    }
  }

  get pending(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

function contentLengthOf(headers: string): number | null {
  let contentLength = 0;
  let found = false;
  for (const line of headers.split('\r\n').slice(1)) {
    const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
    if (match) {
      contentLength = Number(match[1]);
      found = true;
      if (!Number.isFinite(contentLength) || contentLength > 1_000_000) return null;
    }
  }
  // No Content-Length at all means no body, which is legal for many requests.
  return found ? contentLength : 0;
}

/** Classify a serialized message as a SIP response (vs a request). */
export function isResponse(message: string): boolean {
  return message.startsWith('SIP/2.0 ');
}

export function callIdOf(message: string): string {
  for (const line of message.split('\r\n')) {
    if (line === '') break;
    const match = /^call-id:\s*(.+)$/i.exec(line);
    if (match) return match[1].trim();
  }
  return '';
}
