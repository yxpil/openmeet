import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCallId, rememberCalledNumber, rewriteRequestLine, takeCalledNumber } from '../src/ruri.js';

describe('Request-URI rewrite', () => {
  it('points the request at the gateway AOR and reports what was dialled', () => {
    const { line, called } = rewriteRequestLine('INVITE sip:+86215550100@10.0.0.9:5060 SIP/2.0', 'openmeet');
    assert.equal(called, '+86215550100');
    assert.equal(line, 'INVITE sip:openmeet@10.0.0.9:5060 SIP/2.0');
  });

  it('leaves requests already addressed to the AOR untouched', () => {
    const original = 'INVITE sip:openmeet@10.0.0.9:5060 SIP/2.0';
    const { line, called } = rewriteRequestLine(original, 'openmeet');
    assert.equal(line, original);
    assert.equal(called, 'openmeet');
  });

  it('ignores responses, ACK lines and malformed requests', () => {
    assert.equal(rewriteRequestLine('SIP/2.0 200 OK', 'openmeet').line, 'SIP/2.0 200 OK');
    assert.equal(rewriteRequestLine('ACK sip:x@h SIP/2.0', 'openmeet').called, 'x');
    assert.equal(rewriteRequestLine('OPTIONS sip:nouser SIP/2.0', 'openmeet').called, null);
    assert.equal(rewriteRequestLine('garbage', 'openmeet').called, null);
  });

  it('keeps the host part, including a port, intact', () => {
    const { line } = rewriteRequestLine('INVITE sip:9000@gw.example.org:5080 SIP/2.0', 'openmeet');
    assert.ok(line.endsWith('@gw.example.org:5080 SIP/2.0'));
  });
});

describe('called-number registry', () => {
  it('recovers the dialled number by Call-ID', () => {
    const message = [
      'INVITE sip:9000@10.0.0.9 SIP/2.0',
      'Via: SIP/2.0/UDP 10.0.0.5',
      'Call-ID: abc123@10.0.0.5',
      'From: <sip:caller@10.0.0.5>',
      '',
      'v=0'
    ].join('\r\n');
    assert.equal(extractCallId(message), 'abc123@10.0.0.5');
    assert.equal(takeCalledNumber('abc123@10.0.0.5'), '');
    rememberCalledNumber('abc123@10.0.0.5', '9000');
    assert.equal(takeCalledNumber('abc123@10.0.0.5'), '9000');
  });

  it('ignores empty keys and unknown calls', () => {
    rememberCalledNumber('', '9000');
    rememberCalledNumber('id', '');
    assert.equal(takeCalledNumber('id'), '');
    assert.equal(takeCalledNumber(undefined), '');
    assert.equal(extractCallId('INVITE sip:a@b SIP/2.0\r\n'), '');
  });

  it('does not read a Call-ID out of the SDP body', () => {
    const message = 'INVITE sip:9000@h SIP/2.0\r\nCall-ID: real\r\n\r\ncall-id: fake-in-body\r\n';
    assert.equal(extractCallId(message), 'real');
  });
});
