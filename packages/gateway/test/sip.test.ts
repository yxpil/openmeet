import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { Inviter, UserAgent, type UserAgentDelegate } from 'sip.js';
import { SipEndpoint, UdpTransport, selectCodec, type SipCall } from '../src/sip.js';
import { offeredCodecs, parseSdp, pickAudioSection } from '../src/sdp.js';
import { makeRtpPacket } from '../src/rtp.js';
import { pcmToAlaw, pcmToUlaw, ulawToPcm } from '../src/g711.js';

/** Stands in for a hardphone: fixed PCMU offer, plain RTP socket, learns the answer. */
class PhoneMedia {
  readonly socket: Socket = createSocket('udp4');
  readonly received: Buffer[] = [];
  answeredPort = 0;
  answeredSdp = '';
  listenPort = 0;
  readonly ready: Promise<number>;

  constructor() {
    this.socket.on('message', (data) => this.received.push(data));
    this.ready = new Promise((resolve) => {
      this.socket.bind(0, '127.0.0.1', () => {
        this.listenPort = (this.socket.address() as { port: number }).port;
        resolve(this.listenPort);
      });
    });
  }

  get offer(): string {
    return [
      'v=0',
      'o=phone 1 1 IN IP4 127.0.0.1',
      's=phone',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=audio ${this.listenPort} RTP/AVP 0 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-15',
      'a=sendrecv'
    ].join('\r\n');
  }

  sendPayloadType(payload: Uint8Array, payloadType: number): void {
    if (!this.answeredPort) throw new Error('phone has no answer to send to yet');
    this.socket.send(
      makeRtpPacket(payloadType, 1, 1, 999, Buffer.from(payload)).serialize(),
      this.answeredPort,
      '127.0.0.1'
    );
  }
}

function phoneFactory(media: PhoneMedia) {
  return () => ({
    hasDescription: (contentType: string) => contentType === 'application/sdp',
    getDescription: async () => ({ body: media.offer, contentType: 'application/sdp' }),
    setDescription: async (sdp: string) => {
      const audio = pickAudioSection(parseSdp(sdp));
      media.answeredSdp = sdp;
      media.answeredPort = audio?.port ?? 0;
    },
    updateOptions: async () => undefined,
    resetOptions: () => undefined,
    sendDtmf: () => true,
    close: () => undefined
  });
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('codec selection', () => {
  it('prefers Opus 48k so the WebRTC leg needs no transcode', () => {
    const codec = selectCodec(
      offeredCodecs(
        parseSdp(
          [
            'v=0',
            'm=audio 5000 RTP/AVP 96 0 101',
            'a=rtpmap:96 opus/48000/2',
            'a=rtpmap:0 PCMU/8000',
            'a=rtpmap:101 telephone-event/8000'
          ].join('\r\n')
        )
      )
    );
    assert.equal(codec?.encodingName, 'OPUS');
    assert.equal(codec?.clockRate, 48000);
    assert.equal(codec?.telephoneEventPayload, 101);
  });

  it('falls back to PCMU over PCMA and refuses what it cannot decode', () => {
    const both = selectCodec([
      { payloadType: 8, encodingName: 'PCMA', clockRate: 8000, channels: 1 },
      { payloadType: 0, encodingName: 'PCMU', clockRate: 8000, channels: 1 }
    ]);
    assert.equal(both?.encodingName, 'PCMU');
    assert.equal(
      selectCodec([{ payloadType: 18, encodingName: 'G729', clockRate: 8000, channels: 1 }]),
      null
    );
  });
});

describe('SIP dialog with the gateway', () => {
  it('answers an INVITE, carries G.711 both ways, sees DTMF, and observes BYE', async () => {
    const gatewayPort = 5090;
    const phoneSipPort = 5091;
    const media = new PhoneMedia();
    await media.ready;

    const inbound: Uint8Array[] = [];
    const digits: string[] = [];
    let ended = false;
    let caller = '';

    const calls: SipCall[] = [];
    const gateway = new SipEndpoint(
      {
        uri: `sip:gateway@127.0.0.1:${gatewayPort}`,
        listenAddress: '127.0.0.1',
        listenPort: gatewayPort,
        peer: { address: '127.0.0.1', port: phoneSipPort }
      },
      {
        onIncoming: async (call) => {
          calls.push(call);
          caller = call.caller;
          await call.accept();
        },
        onMedia: (_call, payload) => inbound.push(payload),
        onDtmf: (_call, digit) => digits.push(digit),
        onEnded: () => {
          ended = true;
        }
      }
    );
    await gateway.start();

    const phone = new UserAgent({
      uri: UserAgent.makeURI(`sip:caller@127.0.0.1:${phoneSipPort}`),
      transportConstructor: UdpTransport as never,
      transportOptions: {
        listenAddress: '127.0.0.1',
        listenPort: phoneSipPort,
        peer: { address: '127.0.0.1', port: gatewayPort }
      } as never,
      sessionDescriptionHandlerFactory: phoneFactory(media) as never,
      logLevel: 'error'
    });
    phone.delegate = {
      onInvite: (invitation) => {
        void invitation.accept();
        return true;
      }
    } as UserAgentDelegate;
    await phone.start();

    const inviter = new Inviter(phone, UserAgent.makeURI(`sip:gateway@127.0.0.1:${gatewayPort}`)!);
    await inviter.invite();

    // sip.js only builds the media handler once the session starts establishing,
    // so the gateway's RTP port appears shortly after the INVITE is accepted.
    let gatewayMediaPort = 0;
    for (let attempt = 0; attempt < 30 && !gatewayMediaPort; attempt += 1) {
      await settle(100);
      gatewayMediaPort = calls[0]?.handler?.port ?? 0;
    }
    try {
      assert.ok(gatewayMediaPort > 0, 'gateway never reported its RTP port');
      assert.equal(caller, 'caller');
      assert.ok(media.answeredSdp.includes('PCMU/8000'), 'answer should keep PCMU');

      // phone -> gateway: two 20 ms μ-law frames
      const samples = new Int16Array(160).fill(1000);
      media.sendPayloadType(pcmToUlaw(samples), 0);
      media.sendPayloadType(pcmToUlaw(samples), 0);
      await settle(300);
      assert.equal(inbound.length, 2);
      // μ-law is lossy: 1000 lands on the segment-3 code 988 (step 64), so assert
      // within half a step instead of exact equality.
      const decoded = ulawToPcm(inbound[0]!);
      assert.equal(decoded.length, samples.length);
      for (const value of decoded) {
        assert.ok(Math.abs(value - 1000) <= 32, `μ-law round-trip drifted to ${value}`);
      }

      // phone -> gateway: DTMF '7' as RFC 2833
      media.sendPayloadType(Buffer.from([7, 0x0a, 0x00, 0x08]), 101);
      await settle(300);
      assert.deepEqual(digits, ['7']);

      // gateway -> phone: the bridge pushes a frame back
      const outgoing = pcmToAlaw(new Int16Array(160).fill(-2000));
      assert.ok(calls[0]?.handler, 'call lost its media handler');
      calls[0]!.handler!.sendAudio(outgoing);
      await settle(300);
      assert.ok(media.received.length >= 1, 'phone received nothing from the gateway');
      const last = media.received[media.received.length - 1]!;
      assert.deepEqual([...last.subarray(12)], [...outgoing]);

      await inviter.bye();
      await settle(400);
      assert.equal(ended, true, 'gateway did not observe the BYE');
    } finally {
      await phone.stop().catch(() => undefined);
      await gateway.stop().catch(() => undefined);
      media.socket.close();
    }
  });
});
