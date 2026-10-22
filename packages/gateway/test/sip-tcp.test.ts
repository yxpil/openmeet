import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Inviter, UserAgent } from 'sip.js';
import { GatewaySessionDescriptionHandler, SipCall, SipEndpoint } from '../src/sip.js';
import { createSelfSigned } from './helpers/self-signed.js';
import { createTestPhone } from './helpers/phone.js';
import { pcmToUlaw, ulawToPcm } from '../src/g711.js';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A gateway that never dials out: peers connect to it. */
async function listenOnlyGateway(
  port: number,
  transport: 'tcp' | 'tls',
  tls?: { keyPem: string; certPem: string }
) {
  const calls: SipCall[] = [];
  const inbound: Uint8Array[] = [];
  const gateway = new SipEndpoint(
    {
      uri: `sip:gateway@127.0.0.1:${port}`,
      listenAddress: '127.0.0.1',
      listenPort: port,
      peer: null,
      aorUser: 'gateway',
      transport,
      ...(tls ? { tls } : {})
    },
    {
      onIncoming: async (call) => {
        calls.push(call);
        await call.accept();
      },
      onMedia: (_call, payload) => inbound.push(payload)
    }
  );
  await gateway.start();
  return { gateway, calls, inbound };
}

describe('SIP over connection-oriented transports', () => {
  it('completes a TCP dialog where the gateway only listens, so the answer returns on the inbound connection', async () => {
    const gatewayPort = 5110;
    const { gateway, calls, inbound } = await listenOnlyGateway(gatewayPort, 'tcp');
    const phone = await createTestPhone({
      sipPort: 5111,
      peer: { address: '127.0.0.1', port: gatewayPort },
      transport: 'tcp'
    });

    const inviter = new Inviter(
      phone.userAgent,
      UserAgent.makeURI(`sip:9000@127.0.0.1:${gatewayPort}`)!
    );
    await inviter.invite();
    await settle(1200);

    assert.equal(calls.length, 1, 'gateway never saw the INVITE over TCP');
    const handler = calls[0]?.handler;
    assert.ok(handler, 'gateway has no media handler after accepting over TCP');
    assert.ok(phone.answeredPort > 0, 'phone never received an SDP answer');
    assert.ok(handler instanceof GatewaySessionDescriptionHandler);
    assert.equal(handler.mediaCodec?.encodingName, 'PCMU');

    phone.sendRtp(2);
    await settle(400);
    assert.equal(inbound.length, 2);
    // sendRtp alternates sign to avoid DC, so compare magnitude
    assert.ok(Math.abs(Math.abs(ulawToPcm(inbound[0]!)[0]!) - 1500) <= 32);

    handler.sendAudio(pcmToUlaw(new Int16Array(160).fill(-1500)));
    await settle(400);
    assert.ok(phone.received.length >= 1, 'phone received nothing over RTP from the gateway');

    await inviter.bye().catch(() => undefined);
    await settle(400);
    await phone.stop();
    await gateway.stop();
  });

  it('completes the same dialog over TLS with a freshly generated certificate', async () => {
    const gatewayPort = 5112;
    const cert = await createSelfSigned('localhost');
    const { gateway, calls, inbound } = await listenOnlyGateway(gatewayPort, 'tls', cert);
    const phone = await createTestPhone({
      sipPort: 5113,
      peer: { address: '127.0.0.1', port: gatewayPort },
      transport: 'tls'
    });

    const inviter = new Inviter(
      phone.userAgent,
      UserAgent.makeURI(`sip:9000@127.0.0.1:${gatewayPort}`)!
    );
    await inviter.invite();
    await settle(2000);

    assert.equal(calls.length, 1, 'gateway never saw the INVITE over TLS');
    assert.ok(calls[0]?.handler?.port, 'TLS gateway has no media port');
    assert.ok(phone.answeredPort > 0, 'phone never received an SDP answer over TLS');

    phone.sendRtp(1);
    await settle(500);
    assert.equal(inbound.length, 1, 'no RTP arrived through the TLS dialog');

    await inviter.bye().catch(() => undefined);
    await settle(400);
    await phone.stop();
    await gateway.stop();
  });

  it('reports which transport it is actually running', async () => {
    const cert = await createSelfSigned('localhost');
    const tlsGateway = new SipEndpoint({
      uri: 'sip:gateway@127.0.0.1:5114',
      listenAddress: '127.0.0.1',
      listenPort: 5114,
      peer: null,
      aorUser: 'gateway',
      transport: 'tls',
      tls: cert
    });
    const udpGateway = new SipEndpoint({
      uri: 'sip:gateway@127.0.0.1:5115',
      listenAddress: '127.0.0.1',
      listenPort: 5115,
      peer: { address: '127.0.0.1', port: 5115 },
      aorUser: 'gateway'
    });
    await tlsGateway.start();
    await udpGateway.start();
    try {
      assert.equal(tlsGateway.protocol, 'TLS');
      assert.equal(udpGateway.protocol, 'UDP');
    } finally {
      await tlsGateway.stop();
      await udpGateway.stop();
    }
  });
});
