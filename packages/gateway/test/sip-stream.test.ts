import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SipMessageStream, callIdOf, isResponse } from '../src/sip-stream.js';

/** Build a message whose Content-Length always matches the body. */
function message(headers: string[], body: string): string {
  return [...headers, `Content-Length: ${Buffer.byteLength(body, 'utf8')}`, '', body].join('\r\n');
}

// Body is exactly 10 bytes: "v=0\r\nx=1\r\n". Declaring a wrong Content-Length here
// would make the decoder wait forever, so keep the two in step.
const REQUEST_WITH_BODY = [
  'INVITE sip:9000@gw SIP/2.0',
  'Via: SIP/2.0/TCP 10.0.0.5:5060;branch=z9hG4bK-1',
  'Call-ID: tcp-test-1@10.0.0.5',
  'Content-Length: 10',
  '',
  'v=0\r\nx=1\r\n'
].join('\r\n');

function frames(message: string, size: number): Buffer[] {
  const bytes = Buffer.from(message, 'utf8');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

describe('SIP stream framing', () => {
  it('reassembles one message split at every possible byte boundary', () => {
    for (let size = 1; size <= REQUEST_WITH_BODY.length; size += 1) {
      const stream = new SipMessageStream();
      const collected: string[] = [];
      for (const chunk of frames(REQUEST_WITH_BODY, size)) collected.push(...stream.push(chunk));
      assert.deepEqual(collected, [REQUEST_WITH_BODY], `chunk size ${size}`);
      assert.equal(stream.pending, 0);
    }
  });

  it('splits two pipelined messages that arrive in a single chunk', () => {
    const stream = new SipMessageStream();
    const second = message(
      [
        'INVITE sip:9000@gw SIP/2.0',
        'Via: SIP/2.0/TCP 10.0.0.5:5060;branch=z9hG4bK-2',
        'Call-ID: tcp-test-2@10.0.0.5'
      ],
      'v=0' + String.fromCharCode(13, 10)
    );
    const messages = stream.push(Buffer.from(REQUEST_WITH_BODY + second, 'utf8'));
    assert.equal(messages.length, 2);
    assert.equal(callIdOf(messages[0]!), 'tcp-test-1@10.0.0.5');
    assert.equal(callIdOf(messages[1]!), 'tcp-test-2@10.0.0.5');
  });

  it('keeps a body that contains a blank line intact', () => {
    const body = 'a\r\n\r\nb';
    const message = [
      'OPTIONS sip:x SIP/2.0',
      'Call-ID: body-1',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body
    ].join('\r\n');
    const stream = new SipMessageStream();
    const [decoded] = stream.push(Buffer.from(message, 'utf8'));
    assert.equal(decoded, message);
    assert.ok(decoded!.endsWith('b'));
  });

  it('treats a missing Content-Length as no body and waits for a declared one', () => {
    const headerless = 'BYE sip:x SIP/2.0\r\nCall-ID: no-cl\r\n\r\n';
    const stream = new SipMessageStream();
    assert.deepEqual(stream.push(Buffer.from(headerless, 'utf8')), [headerless]);

    const waiting = new SipMessageStream();
    const whole = message(
      ['NOTIFY sip:x SIP/2.0', 'Call-ID: wait'],
      'short body that is deliberately split across two reads'
    );
    const head = whole.slice(0, whole.length - 20);
    const tail = whole.slice(head.length);
    assert.deepEqual(waiting.push(Buffer.from(head, 'utf8')), [], 'must wait for the declared body');
    assert.ok(waiting.pending > 0);
    const rest = waiting.push(Buffer.from(tail, 'utf8'));
    assert.deepEqual(rest, [whole]);
  });

  it('drops a buffer that never completes instead of growing forever', () => {
    const stream = new SipMessageStream();
    const junk = Buffer.alloc(70_000, 0x41);
    stream.push(junk);
    assert.equal(stream.pending, 0);
  });

  it('classifies requests and responses', () => {
    assert.equal(isResponse('SIP/2.0 200 OK\r\nCall-ID: a'), true);
    assert.equal(isResponse('INVITE sip:a@b SIP/2.0\r\nCall-ID: a'), false);
    assert.equal(callIdOf('INVITE sip:a@b SIP/2.0\r\nCALL-ID: mixed\r\n\r\n'), 'mixed');
  });
});
