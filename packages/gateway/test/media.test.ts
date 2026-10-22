import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RtpPacket } from 'werift';
import { buildAudioSdp, offeredCodecs, parseSdp, pickAudioSection } from '../src/sdp.js';
import { RtpEndpoint, buildTelephoneEvent, makeRtpPacket, parseTelephoneEvent } from '../src/rtp.js';

const REMOTE_SDP = [
  'v=0',
  'o=asterisk 1234 1235 IN IP4 10.0.0.5',
  's=SIP Call',
  'c=IN IP4 10.0.0.5',
  't=0 0',
  'm=audio 45120 RTP/AVP 0 8 101',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-11',
  'a=sendrecv',
  'a=candidate:1 1 UDP 2130706431 10.0.0.5 45120 typ host'
].join('\r\n');

describe('SDP', () => {
  it('reads codecs, parameters and direction from a telephony offer', () => {
    const sdp = parseSdp(REMOTE_SDP);
    assert.equal(sdp.connectionIp, '10.0.0.5');
    const media = pickAudioSection(sdp);
    assert.equal(media?.port, 45120);
    assert.equal(media?.direction, 'sendrecv');
    assert.equal(media?.iceCandidates.length, 1);
    const codecs = offeredCodecs(sdp);
    assert.deepEqual(
      codecs.map((codec) => `${codec.payloadType}:${codec.encodingName}:${codec.clockRate}`),
      ['0:PCMU:8000', '8:PCMA:8000', '101:TELEPHONE_EVENT:8000']
    );
    assert.equal(codecs[2]?.fmtp, '0-11');
  });

  it('keeps an Opus section with its fmtp and channel count', () => {
    const sdp = parseSdp(
      buildAudioSdp({
        port: 40000,
        address: '10.0.0.9',
        codecs: [
          {
            payloadType: 96,
            encodingName: 'opus',
            clockRate: 48000,
            channels: 2,
            fmtp: 'minptime=10;useinbandfec=1'
          },
          { payloadType: 0, encodingName: 'PCMU', clockRate: 8000 },
          { payloadType: 101, encodingName: 'telephone-event', clockRate: 8000 }
        ]
      })
    );
    const codecs = offeredCodecs(sdp);
    assert.equal(codecs[0]?.encodingName, 'OPUS');
    assert.equal(codecs[0]?.channels, 2);
    assert.equal(codecs[0]?.fmtp, 'minptime=10;useinbandfec=1');
    assert.equal(codecs[1]?.encodingName, 'PCMU');
    assert.equal(pickAudioSection(sdp)?.port, 40000);
  });

  it('treats a rejected section as port 0', () => {
    const sdp = parseSdp('v=0\r\nm=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n');
    assert.equal(pickAudioSection(sdp)?.port, 0);
  });
});

describe('RTP endpoint', () => {
  it('receives packets and learns the symmetric peer', async () => {
    const a = await RtpEndpoint.create({ port: 0 });
    const b = await RtpEndpoint.create({ port: 0 });
    try {
      const seen: RtpPacket[] = [];
      b.onPacket((packet) => seen.push(packet));
      a.setPeer({ address: '127.0.0.1', port: b.port });

      a.send(makeRtpPacket(0, 1, 160, 1234, Buffer.from([0xff, 0xd5])));
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.header.payloadType, 0);
      assert.deepEqual([...(seen[0]?.payload ?? [])], [0xff, 0xd5]);
      assert.equal(a.send(makeRtpPacket(0, 9, 9, 9, Buffer.from([0x00]), true)), true);

      // b replies to the learned source, so it needs no configured peer
      const aSeen: RtpPacket[] = [];
      a.onPacket((packet) => aSeen.push(packet));
      b.send(makeRtpPacket(0, 2, 320, 4321, Buffer.from([0x00])));
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(aSeen.length, 1);
      assert.equal(a.peerAddress?.port, b.port);
    } finally {
      a.close();
      b.close();
    }
  });

  it('refuses to send before the peer is known', async () => {
    const a = await RtpEndpoint.create({ port: 0 });
    try {
      assert.equal(a.send(makeRtpPacket(0, 1, 160, 1, Buffer.from([0xff]))), false);
    } finally {
      a.close();
    }
  });

  it('drops malformed datagrams instead of throwing', async () => {
    const b = await RtpEndpoint.create({ port: 0 });
    const { createSocket } = await import('node:dgram');
    const raw = createSocket('udp4');
    try {
      let handled = 0;
      b.onPacket(() => {
        handled += 1;
      });
      await new Promise<void>((resolve) => raw.bind(0, '127.0.0.1', () => resolve()));
      raw.send(Buffer.from([1, 2, 3]), b.port, '127.0.0.1');
      raw.send(Buffer.from('not rtp at all!!'), b.port, '127.0.0.1');
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(handled, 0);
    } finally {
      raw.close();
      b.close();
    }
  });
});

describe('telephone-event', () => {
  it('round-trips DTMF digits', () => {
    for (const digit of ['0', '5', '*', '#', 'D']) {
      const payload = buildTelephoneEvent(digit, 160, true);
      const event = parseTelephoneEvent(payload);
      assert.equal(event?.digit, digit);
      assert.equal(event?.ended, true);
      assert.equal(event?.durationMs, 160);
    }
  });

  it('ignores short payloads', () => {
    assert.equal(parseTelephoneEvent(Buffer.from([1, 2])), null);
  });
});
