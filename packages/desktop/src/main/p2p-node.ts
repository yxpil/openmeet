import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import {
  P2P_BEACON_INTERVAL_MS,
  P2P_DISCOVERY_PORT,
  P2P_MULTICAST_V4,
  P2P_PEER_TIMEOUT_MS,
  P2P_PROTOCOL,
  EMPTY_P2P_STATE,
  type P2pBeacon,
  type P2pLinkMessage,
  type P2pMediaState,
  type P2pPeerInfo
} from '../shared/p2p.js';

export interface P2pNodeOptions {
  code: string;
  passphrase: string;
  displayName: string;
  /** Preferred signaling port; the node falls back to an ephemeral port. */
  port?: number;
  /** Shared UDP port every node on the LAN listens on for beacons. */
  discoveryPort?: number;
  multicastGroup?: string;
  /** Injectable for tests: emit beacons to these addresses instead of LAN-wide. */
  directTargets?: { address: string; port: number }[];
  log?: (message: string) => void;
}

export interface P2pNodeEvents {
  onPeers?: (peers: P2pPeerInfo[]) => void;
  onSignal?: (from: string, data: unknown) => void;
  onChat?: (message: { id: string; from: string; name: string; text: string; at: number }) => void;
  onHand?: (peerId: string, raised: boolean) => void;
  onMuteRequest?: (target: string, by: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onFatal?: (message: string) => void;
}

interface RemotePeer extends P2pPeerInfo {
  socket: WebSocket | null;
  lastSeen: number;
  greeted: boolean;
}

/**
 * Room digest: HMAC over the normalised code keyed by the passphrase. Peers only
 * ever exchange the digest, so the passphrase stays on each machine and a
 * bystander cannot join or learn which meeting is which.
 */
export function deriveRoomId(code: string, passphrase: string): string {
  const normalised = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHmac('sha256', passphrase || 'openmeet-lan')
    .update(`om-p2p-v1:${normalised}`)
    .digest('hex')
    .slice(0, 32);
}

function sameBytes(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * One member of a serverless LAN meeting: announces itself over UDP, accepts
 * signaling connections, and keeps a full mesh of WebSocket links.
 */
export class P2pNode {
  readonly peerId = `p_${randomUUID()}`;
  readonly roomId: string;
  readonly discoveryPort: number;
  port = 0;
  private readonly options: P2pNodeOptions;
  private readonly events: P2pNodeEvents;
  private readonly peers = new Map<string, RemotePeer>();
  private readonly pendingSignals = new Map<string, unknown[]>();
  private udp: Socket | null = null;
  private server: WebSocketServer | null = null;
  private beaconTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private state: P2pMediaState = { ...EMPTY_P2P_STATE };
  private started = false;
  private closing = false;

  constructor(options: P2pNodeOptions, events: P2pNodeEvents = {}) {
    this.options = options;
    this.events = events;
    this.discoveryPort = options.discoveryPort ?? P2P_DISCOVERY_PORT;
    this.roomId = deriveRoomId(options.code, options.passphrase);
  }

  get selfInfo(): P2pPeerInfo {
    return {
      peerId: this.peerId,
      name: this.options.displayName,
      host: '127.0.0.1',
      port: this.port,
      state: this.state
    };
  }

  get roster(): P2pPeerInfo[] {
    return [...this.peers.values()].map((peer) => ({
      peerId: peer.peerId,
      name: peer.name,
      host: peer.host,
      port: peer.port,
      state: peer.state,
      connector: peer.socket !== null
    }));
  }

  async start(): Promise<number> {
    if (this.started) return this.port;
    this.started = true;
    await this.listenSignaling();
    await this.listenUdp();
    this.beaconTimer = setInterval(() => this.announce(), P2P_BEACON_INTERVAL_MS);
    this.beaconTimer.unref?.();
    this.pruneTimer = setInterval(() => this.pruneStale(), 2000);
    this.pruneTimer.unref?.();
    this.announce();
    return this.port;
  }

  private listenSignaling(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: '0.0.0.0', port: this.options.port ?? 0 });
      this.server = server;
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.on('listening', () => {
        server.removeListener('error', onError);
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
      server.on('connection', (socket, request) => {
        this.onInboundLink(socket, request.socket.remoteAddress ?? '127.0.0.1');
      });
    });
  }

  private listenUdp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      this.udp = socket;
      socket.once('error', reject);
      socket.bind(this.discoveryPort, '0.0.0.0', () => {
        socket.removeListener('error', reject);
        try {
          socket.setBroadcast(true);
          socket.addMembership(this.options.multicastGroup ?? P2P_MULTICAST_V4);
        } catch (error) {
          // Multicast can be blocked by the OS or network; broadcast still works.
          this.options.log?.(`组播不可用，仅用广播：${error instanceof Error ? error.message : String(error)}`);
        }
        socket.on('message', (data) => this.onBeacon(data));
        resolve();
      });
    });
  }

  private beaconPayload(kind: P2pBeacon['kind']): P2pBeacon {
    return {
      m: 'om-p2p',
      v: P2P_PROTOCOL,
      room: this.roomId,
      peerId: this.peerId,
      name: this.options.displayName,
      port: this.port,
      host: primaryLanAddress(),
      kind,
      sentAt: Date.now()
    };
  }

  private announce(): void {
    if (!this.udp || this.closing) return;
    const payload = Buffer.from(JSON.stringify(this.beaconPayload('announce')), 'utf8');
    const targets = this.options.directTargets ?? defaultTargets(this.discoveryPort, this.options.multicastGroup);
    for (const target of targets) {
      try {
        this.udp.send(payload, target.port, target.address);
      } catch {
        // one unreachable target must not stop discovery through the others
      }
    }
  }

  /** Stop announcing without closing the node: used to simulate a machine that
   *  disappears before it can send a bye. */
  stopAnnouncing(): void {
    if (this.beaconTimer) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
    }
  }

  private onBeacon(data: Buffer): void {
    let beacon: P2pBeacon;
    try {
      beacon = JSON.parse(data.toString('utf8')) as P2pBeacon;
    } catch {
      return;
    }
    if (beacon.m !== 'om-p2p' || beacon.v !== P2P_PROTOCOL) return;
    if (!sameBytes(beacon.room, this.roomId)) return;
    if (beacon.peerId === this.peerId) return;

    if (beacon.kind === 'bye') {
      const known = this.peers.get(beacon.peerId);
      if (known) {
        this.dropPeer(beacon.peerId);
        this.events.onPeerLeft?.(beacon.peerId);
      }
      return;
    }

    const existing = this.peers.get(beacon.peerId);
    if (existing) {
      existing.lastSeen = Date.now();
      if (existing.host !== beacon.host || existing.port !== beacon.port) {
        existing.host = beacon.host;
        existing.port = beacon.port;
        this.events.onPeers?.(this.roster);
      }
    } else {
      this.peers.set(beacon.peerId, {
        peerId: beacon.peerId,
        name: beacon.name,
        host: beacon.host,
        port: beacon.port,
        state: { ...EMPTY_P2P_STATE },
        socket: null,
        lastSeen: Date.now(),
        greeted: false
      });
      this.events.onPeers?.(this.roster);
    }
    // Deterministic single connect: the lower peer id dials the higher one.
    if (this.peerId < beacon.peerId && !this.peers.get(beacon.peerId)?.socket) {
      void this.dial(beacon.peerId);
    }
  }

  private dial(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.socket || this.closing) return;
    const socket = new WebSocket(`ws://${peer.host}:${peer.port}/`);
    socket.on('error', () => {
      if (peer.socket === null) {
        // retry on the next beacon
      }
    });
    socket.on('open', () => {
      peer.socket = socket;
      peer.lastSeen = Date.now();
      this.send(socket, {
        type: 'hello',
        room: this.roomId,
        peerId: this.peerId,
        name: this.options.displayName,
        state: this.state
      });
      // A roster entry born from a beacon has no media state at all, so push ours
      // as soon as the link is usable instead of waiting for the next toggle.
      this.send(socket, { type: 'media', peerId: this.peerId, state: this.state });
      // Tell the other end about everyone else so the mesh closes.
      for (const known of this.peers.values()) {
        if (known.peerId !== peerId) this.send(socket, { type: 'referral', peer: this.infoOf(known) });
      }
      this.flushSignals(peerId);
    });
    socket.on('message', (raw) => this.handleLink(peerId, raw, socket));
    socket.on('close', () => {
      if (peer.socket === socket) {
        peer.socket = null;
        this.events.onPeers?.(this.roster);
      }
    });
  }

  private onInboundLink(socket: WebSocket, host: string): void {
    let peerId = '';
    socket.on('message', (raw) => {
      let message: P2pLinkMessage;
      try {
        message = JSON.parse(raw.toString()) as P2pLinkMessage;
      } catch {
        return;
      }
      // The first frame must be hello with our room digest, or we hang up.
      if (message.type === 'hello') {
        if (!sameBytes(message.room, this.roomId)) {
          socket.close(4001, 'room mismatch');
          return;
        }
        peerId = message.peerId;
        const existing = this.peers.get(peerId);
        const peer =
          existing ??
          ({
            peerId,
            name: message.name,
            host,
            port: 0,
            state: message.state,
            socket: null,
            lastSeen: Date.now(),
            greeted: false
          } as RemotePeer);
        peer.name = message.name;
        peer.state = message.state;
        peer.socket = socket;
        peer.lastSeen = Date.now();
        peer.greeted = true;
        this.peers.set(peerId, peer);
        this.send(socket, {
          type: 'welcome',
          peerId: this.peerId,
          name: this.options.displayName,
          state: this.state,
          peers: this.roster.filter((item) => item.peerId !== peerId).map(this.infoOf)
        });
        this.send(socket, { type: 'media', peerId: this.peerId, state: this.state });
        for (const known of this.peers.values()) {
          if (known.peerId !== peerId) this.broadcast({ type: 'referral', peer: this.infoOf(known) });
        }
        this.flushSignals(peerId);
        this.events.onPeers?.(this.roster);
        return;
      }
      if (!peerId) {
        socket.close(4002, 'expected hello');
        return;
      }
      this.handleLink(peerId, raw, socket);
    });
    socket.on('close', () => {
      const peer = peerId ? this.peers.get(peerId) : undefined;
      if (peer?.socket === socket) {
        peer.socket = null;
        this.events.onPeers?.(this.roster);
      }
    });
  }

  private handleLink(peerId: string, raw: unknown, socket: WebSocket): void {
    let message: P2pLinkMessage;
    try {
      message = JSON.parse(String(raw)) as P2pLinkMessage;
    } catch {
      return;
    }
    const peer = this.peers.get(peerId);
    if (peer) peer.lastSeen = Date.now();
    switch (message.type) {
      case 'welcome': {
        if (!peer) return;
        peer.name = message.name;
        peer.state = message.state;
        peer.greeted = true;
        for (const referred of message.peers) this.remember(referred);
        this.events.onPeers?.(this.roster);
        return;
      }
      case 'referral': {
        this.remember(message.peer);
        // Learn the newcomer's address even before it dials us.
        this.events.onPeers?.(this.roster);
        return;
      }
      case 'signal':
        this.events.onSignal?.(message.from, message.data);
        return;
      case 'media': {
        if (!peer) return;
        peer.state = message.state;
        this.events.onPeers?.(this.roster);
        return;
      }
      case 'chat':
        this.events.onChat?.({
          id: message.id,
          from: message.from,
          name: message.name,
          text: message.text,
          at: message.at
        });
        return;
      case 'hand': {
        if (!peer) return;
        peer.state = { ...peer.state, handRaised: message.raised };
        this.events.onHand?.(message.peerId, message.raised);
        this.events.onPeers?.(this.roster);
        return;
      }
      case 'mute-request':
        if (message.target === this.peerId) this.events.onMuteRequest?.(message.target, message.by);
        return;
      case 'leave':
        this.dropPeer(message.peerId);
        this.events.onPeerLeft?.(message.peerId);
        return;
      case 'hello': {
        // Duplicate hello after a reconnect: refresh and answer once.
        if (peer && !peer.greeted) {
          peer.greeted = true;
          this.send(socket, {
            type: 'welcome',
            peerId: this.peerId,
            name: this.options.displayName,
            state: this.state,
            peers: this.roster.filter((item) => item.peerId !== peer.peerId).map(this.infoOf)
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private infoOf = (peer: P2pPeerInfo | RemotePeer): P2pPeerInfo => ({
    peerId: peer.peerId,
    name: peer.name,
    host: peer.host,
    port: peer.port,
    state: peer.state
  });

  private remember(incoming: P2pPeerInfo): void {
    if (incoming.peerId === this.peerId) return;
    const existing = this.peers.get(incoming.peerId);
    if (existing) {
      existing.host = incoming.host || existing.host;
      existing.port = incoming.port || existing.port;
      existing.name = incoming.name || existing.name;
      existing.lastSeen = Date.now();
      return;
    }
    this.peers.set(incoming.peerId, {
      peerId: incoming.peerId,
      name: incoming.name,
      host: incoming.host,
      port: incoming.port,
      state: incoming.state ?? { ...EMPTY_P2P_STATE },
      socket: null,
      lastSeen: Date.now(),
      greeted: false
    });
    // The lower id always dials, so a referral may need a connection from us.
    if (this.peerId < incoming.peerId) void this.dial(incoming.peerId);
  }

  private dropPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    peer?.socket?.close();
    this.peers.delete(peerId);
    this.pendingSignals.delete(peerId);
  }

  private pruneStale(): void {
    const now = Date.now();
    let changed = false;
    for (const [peerId, peer] of [...this.peers]) {
      if (now - peer.lastSeen > P2P_PEER_TIMEOUT_MS) {
        this.dropPeer(peerId);
        changed = true;
        this.events.onPeerLeft?.(peerId);
      }
    }
    if (changed) this.events.onPeers?.(this.roster);
  }

  private send(socket: WebSocket | null, message: P2pLinkMessage): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private broadcast(message: P2pLinkMessage, except?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.peerId === except) continue;
      this.send(peer.socket, message);
    }
  }

  /** Relay a WebRTC signal along the link to one peer (either direction). */
  signal(to: string, data: unknown): void {
    const peer = this.peers.get(to);
    if (!peer || !peer.socket) {
      // Nothing orders an offer against the link that carries it, so an early
      // signal is normal here. Dropping it would stall negotiation forever.
      const queue = this.pendingSignals.get(to) ?? [];
      if (queue.length < 128) queue.push(data);
      this.pendingSignals.set(to, queue);
      return;
    }
    this.send(peer.socket, { type: 'signal', from: this.peerId, data });
  }

  private flushSignals(peerId: string): void {
    const queued = this.pendingSignals.get(peerId);
    if (!queued?.length) return;
    this.pendingSignals.delete(peerId);
    const peer = this.peers.get(peerId);
    if (!peer?.socket) return;
    for (const data of queued) {
      this.send(peer.socket, { type: 'signal', from: this.peerId, data });
    }
  }

  sendChat(text: string, id: string, at: number): void {
    this.broadcast({
      type: 'chat',
      id,
      from: this.peerId,
      name: this.options.displayName,
      text,
      at
    });
  }

  updateState(state: P2pMediaState): void {
    this.state = state;
    this.broadcast({ type: 'media', peerId: this.peerId, state });
  }

  raiseHand(raised: boolean): void {
    this.state = { ...this.state, handRaised: raised };
    this.broadcast({ type: 'hand', peerId: this.peerId, raised });
  }

  requestMute(target: string): void {
    this.broadcast({ type: 'mute-request', target, by: this.peerId });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    const bye = Buffer.from(JSON.stringify(this.beaconPayload('bye')), 'utf8');
    if (this.udp) {
      for (const target of defaultTargets(this.discoveryPort, this.options.multicastGroup)) {
        try {
          this.udp.send(bye, target.port, target.address);
        } catch {
          // best effort notification
        }
      }
    }
    this.broadcast({ type: 'leave', peerId: this.peerId });
    for (const peer of this.peers.values()) peer.socket?.close();
    this.peers.clear();
    this.udp?.close();
    this.udp = null;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }
}

function defaultTargets(port: number, group?: string): { address: string; port: number }[] {
  const targets = [{ address: '255.255.255.255', port }];
  for (const address of subnetBroadcasts()) targets.push({ address, port });
  targets.push({ address: group ?? P2P_MULTICAST_V4, port });
  return targets;
}

/** Best-guess subnet broadcast addresses from our own IPv4 address. */
function subnetBroadcasts(): string[] {
  const address = primaryLanAddress();
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return [];
  return [`${parts[0]}.${parts[1]}.${parts[2]}.255`];
}

function primaryLanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254')) {
        return info.address;
      }
    }
  }
  return '127.0.0.1';
}
