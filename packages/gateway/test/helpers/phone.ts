import { createSocket } from 'node:dgram';
import { UserAgent } from 'sip.js';
import { TcpTransport } from '../../src/sip-tcp.js';
import { pickAudioSection, parseSdp } from '../../src/sdp.js';
import { makeRtpPacket } from '../../src/rtp.js';
import { pcmToUlaw } from '../../src/g711.js';

export interface TestPhone {
  userAgent: UserAgent;
  rtp: ReturnType<typeof createSocket>;
  received: Buffer[];
  sendRtp(count: number, amplitude?: number, payloadType?: number): void;
  readonly answeredPort: number;
  readonly rtpPort: number;
  stop(): Promise<void>;
}

/**
 * A hardphone for tests: SIP over TCP or TLS, RTP over UDP, PCMU + telephone-event.
 * Shared by the TCP and TLS suites so both transports are driven identically.
 */
export async function createTestPhone(options: {
  sipPort: number;
  peer: { address: string; port: number };
  transport: 'tcp' | 'tls';
  user?: string;
  rejectUnauthorized?: boolean;
}): Promise<TestPhone> {
  const received: Buffer[] = [];
  const rtp = createSocket('udp4');
  rtp.on('message', (data) => received.push(data));
  const rtpPort = await new Promise<number>((resolve) => {
    rtp.bind(0, '127.0.0.1', () => resolve((rtp.address() as { port: number }).port));
  });
  const state = { answeredPort: 0 };

  const userAgent = new UserAgent({
    uri: UserAgent.makeURI(`sip:${options.user ?? 'caller'}@127.0.0.1:${options.sipPort}`),
    transportConstructor: TcpTransport,
    transportOptions: {
      listenAddress: '127.0.0.1',
      listenPort: options.sipPort,
      peer: options.peer,
      aorUser: options.user ?? 'caller',
      transport: options.transport,
      rejectUnauthorized: options.rejectUnauthorized ?? false
    },
    sessionDescriptionHandlerFactory: () => ({
      hasDescription: (type: string) => type === 'application/sdp',
      getDescription: async () => ({
        body: [
          'v=0',
          'o=phone 1 1 IN IP4 127.0.0.1',
          's=phone',
          'c=IN IP4 127.0.0.1',
          't=0 0',
          `m=audio ${rtpPort} RTP/AVP 0 101`,
          'a=rtpmap:0 PCMU/8000',
          'a=rtpmap:101 telephone-event/8000',
          'a=fmtp:101 0-15',
          'a=sendrecv'
        ].join('\r\n'),
        contentType: 'application/sdp'
      }),
      setDescription: async (sdp: string) => {
        const audio = pickAudioSection(parseSdp(sdp));
        state.answeredPort = audio?.port ?? 0;
      },
      updateOptions: async () => undefined,
      resetOptions: () => undefined,
      sendDtmf: () => true,
      close: () => undefined
    }),
    logLevel: 'error'
  });
  userAgent.delegate = {
    onInvite: (invitation) => {
      void invitation.accept();
      return true;
    }
  };
  await userAgent.start();

  return {
    userAgent,
    rtp,
    received,
    get answeredPort() {
      return state.answeredPort;
    },
    rtpPort,
    /** Send `count` 20 ms RTP frames of the given amplitude to the answered port. */
    sendRtp(count: number, amplitude = 1500, payloadType = 0) {
      let sequence = 1;
      let timestamp = 160;
      for (let i = 0; i < count; i += 1) {
        const samples = new Int16Array(160).fill(i % 2 ? amplitude : -amplitude);
        rtp.send(
          makeRtpPacket(
            payloadType,
            sequence++,
            timestamp,
            7,
            Buffer.from(pcmToUlaw(samples))
          ).serialize(),
          state.answeredPort,
          '127.0.0.1'
        );
        timestamp += 160;
      }
    },
    async stop() {
      await userAgent.stop();
      rtp.close();
    }
  };
}
