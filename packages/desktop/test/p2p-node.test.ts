import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { P2pNode, deriveRoomId } from '../src/main/p2p-node.js';
import { EMPTY_P2P_STATE, type P2pBeacon } from '../src/shared/p2p.js';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 9000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await settle(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function linked(node: P2pNode, peerId: string): boolean {
  return node.roster.some((peer) => peer.peerId === peerId && peer.connector);
}

describe('serverless LAN meeting node', () => {
  it('derives a stable room digest that differs per code and passphrase', () => {
    assert.equal(deriveRoomId('abc-def-ghi', 'pw'), deriveRoomId('ABCDEF GHI', 'pw'));
    assert.notEqual(deriveRoomId('ABCDEFGHI', 'pw'), deriveRoomId('ABCDEFGHI', 'other'));
    assert.notEqual(deriveRoomId('ABCDEFGHI', 'pw'), deriveRoomId('ABCDEFGHJ', 'pw'));
    assert.match(deriveRoomId('X', 'pw'), /^[0-9a-f]{32}$/);
  });

  it('discovers, links, and exchanges signals, chat and media state', async () => {
    const signalsA: unknown[] = [];
    const signalsB: unknown[] = [];
    const chatsB: string[] = [];
    // Each node listens UDP on its own discovery port here so the test can aim
    // beacons at loopback without depending on LAN broadcast behaviour. The
    // beacon still carries the *signaling* port, which is what peers dial.
    const a = new P2pNode(
      {
        code: 'AAA-BBB-CCC',
        passphrase: 'shared',
        displayName: '甲',
        port: 45601,
        discoveryPort: 45701,
        directTargets: [{ address: '127.0.0.1', port: 45702 }]
      },
      { onSignal: (_from, data) => signalsA.push(data) }
    );
    const b = new P2pNode(
      {
        code: 'AAA-BBB-CCC',
        passphrase: 'shared',
        displayName: '乙',
        port: 45602,
        discoveryPort: 45702,
        directTargets: [{ address: '127.0.0.1', port: 45701 }]
      },
      {
        onSignal: (_from, data) => signalsB.push(data),
        onChat: (message) => chatsB.push(message.text)
      }
    );
    try {
      await a.start();
      await b.start();
      await waitFor(() => a.roster.length > 0 && b.roster.length > 0, 9000, 'mutual discovery');
      // Only the lower peer id dials, so exactly one side holds the connection.
      await waitFor(() => linked(a, b.peerId) || linked(b, a.peerId), 6000, 'an authenticated link');

      a.signal(b.peerId, { kind: 'offer', sdp: 'v=0' });
      await waitFor(() => signalsB.length === 1, 4000, 'signal delivery');
      assert.deepEqual(signalsB[0], { kind: 'offer', sdp: 'v=0' });

      b.signal(a.peerId, { kind: 'answer', sdp: 'v=1' });
      await waitFor(() => signalsA.length === 1, 4000, 'reverse signal delivery');

      a.sendChat('你好', 'c1', Date.now());
      await waitFor(() => chatsB.length === 1, 4000, 'chat delivery');
      assert.equal(chatsB[0], '你好');

      b.updateState({ ...EMPTY_P2P_STATE, mic: true });
      await waitFor(
        () => a.roster.find((peer) => peer.peerId === b.peerId)?.state.mic === true,
        4000,
        'media state gossip'
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('refuses a node that cannot prove the passphrase', async () => {
    const host = new P2pNode({
      code: 'ZZZ-YYY-XXX',
      passphrase: 'correct',
      displayName: '主人',
      port: 45603,
      discoveryPort: 45703
    });
    const intruder = new P2pNode(
      {
        code: 'ZZZ-YYY-XXX',
        passphrase: 'guessed',
        displayName: '闯入者',
        port: 45604,
        discoveryPort: 45704,
        directTargets: [{ address: '127.0.0.1', port: 45703 }]
      },
      {}
    );
    try {
      await host.start();
      await intruder.start();
      await settle(3000);
      assert.equal(host.roster.length, 0, 'wrong passphrase must not join the room');
      assert.equal(intruder.roster.filter((peer) => peer.connector).length, 0);
    } finally {
      await host.close();
      await intruder.close();
    }
  });

  it('beacons go to the shared discovery port and carry the signaling port', async () => {
    // The invariant that used to be broken: nodes get ephemeral signaling ports,
    // so a beacon sent to your own port would never be heard by anybody else.
    const discoveryPort = 45921;
    const heard: P2pBeacon[] = [];
    const listener = createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.bind(discoveryPort, '0.0.0.0', () => {
        listener.removeListener('error', reject);
        resolve();
      });
    });
    listener.on('message', (data) => {
      try {
        heard.push(JSON.parse(data.toString('utf8')) as P2pBeacon);
      } catch {
        // ignore unrelated traffic
      }
    });

    const node = new P2pNode({ code: 'BEACON-TEST', passphrase: 'p', displayName: '甲', discoveryPort }, {});
    try {
      const signalingPort = await node.start();
      await waitFor(() => heard.length > 0, 6000, 'a beacon on the shared discovery port');
      const beacon = heard[0]!;
      assert.equal(beacon.m, 'om-p2p');
      assert.equal(beacon.kind, 'announce');
      assert.equal(beacon.port, signalingPort, 'beacon must advertise the port peers dial');
      assert.notEqual(beacon.port, discoveryPort);
      assert.match(beacon.room, /^[0-9a-f]{32}$/);
    } finally {
      await node.close();
      listener.close();
    }
  });

  it('prunes a peer that vanishes without saying bye', async () => {    const keeper = new P2pNode({
      code: 'KKK-LLL-MMM',
      passphrase: 'p',
      displayName: '留守',
      port: 45605,
      discoveryPort: 45705
    });
    const flapper = new P2pNode(
      {
        code: 'KKK-LLL-MMM',
        passphrase: 'p',
        displayName: '短暂',
        port: 45606,
        discoveryPort: 45706,
        directTargets: [{ address: '127.0.0.1', port: 45705 }]
      },
      {}
    );
    try {
      await keeper.start();
      await flapper.start();
      await waitFor(() => keeper.roster.length === 1, 9000, 'peer learned');
      flapper.stopAnnouncing();
      await waitFor(() => keeper.roster.length === 0, 12000, 'stale peer pruned');
    } finally {
      await keeper.close();
      await flapper.close();
    }
  });
});
