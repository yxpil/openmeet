import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { RtpHeader, RtpPacket } from 'werift';

export interface RtpTarget {
  address: string;
  port: number;
}

export interface RtpEndpointOptions {
  port: number;
  address?: string;
  /**
   * When true the endpoint only accepts packets from the peer it has seen
   * first (or the configured peer). Off by default because telephony media
   * relays legitimately change source ports.
   */
  lockToFirstPeer?: boolean;
}

/** Plain (unsolicited) RTP/RTCP endpoint on the SIP side of the bridge. */
export class RtpEndpoint {
  readonly socket: Socket;
  readonly port: number;
  private peer: RtpTarget | null = null;
  private readonly lock: boolean;
  private packetHandler: ((packet: RtpPacket, from: RtpTarget) => void) | null = null;
  private closed = false;

  private constructor(socket: Socket, options: RtpEndpointOptions) {
    this.socket = socket;
    this.port = (socket.address() as { port: number }).port;
    this.lock = options.lockToFirstPeer ?? false;
    socket.on('message', (data, rinfo) => this.onMessage(data, rinfo));
  }

  static create(options: RtpEndpointOptions): Promise<RtpEndpoint> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.once('error', reject);
      socket.bind(options.port, options.address ?? '0.0.0.0', () => {
        socket.removeListener('error', reject);
        resolve(new RtpEndpoint(socket, options));
      });
    });
  }

  get peerAddress(): RtpTarget | null {
    return this.peer;
  }

  setPeer(target: RtpTarget): void {
    this.peer = target;
  }

  onPacket(handler: (packet: RtpPacket, from: RtpTarget) => void): void {
    this.packetHandler = handler;
  }

  /** Send an RTP packet, defaulting to the learned peer (symmetric RTP). */
  send(packet: RtpPacket, target?: RtpTarget): boolean {
    if (this.closed) return false;
    const destination = target ?? this.peer;
    if (!destination) return false;
    this.socket.send(packet.serialize(), destination.port, destination.address);
    return true;
  }

  sendRtcp(data: Buffer, target?: RtpTarget): boolean {
    if (this.closed) return false;
    const destination = target ?? this.peer;
    if (!destination) return false;
    this.socket.send(data, destination.port, destination.address);
    return true;
  }

  private onMessage(data: Buffer, rinfo: RemoteInfo): void {
    const from = { address: rinfo.address, port: rinfo.port };
    if (!this.peer) this.peer = from;
    if (this.lock && (from.address !== this.peer.address || from.port !== this.peer.port)) return;
    if (data.length < 12) return;
    let packet: RtpPacket;
    try {
      packet = RtpPacket.deSerialize(data);
    } catch {
      return;
    }
    this.packetHandler?.(packet, from);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

export function makeRtpPacket(
  payloadType: number,
  sequenceNumber: number,
  timestamp: number,
  ssrc: number,
  payload: Buffer,
  marker = false
): RtpPacket {
  return new RtpPacket(
    new RtpHeader({ version: 2, payloadType, sequenceNumber, timestamp, ssrc, marker }),
    payload
  );
}

export interface DtmfEvent {
  digit: string;
  durationMs: number;
  ended: boolean;
}

/**
 * Decode RFC 2833 / RFC 4733 telephone-event payload.
 * Payload is 4 octets: event, E+volume, duration (big endian).
 */
export function parseTelephoneEvent(payload: Buffer): DtmfEvent | null {
  if (payload.length < 4) return null;
  const event = payload.readUInt8(0);
  const digit = TELEPHONY_EVENTS[event];
  if (!digit) return null;
  return {
    digit,
    durationMs: (payload.readUInt16BE(2) * 20) | 0,
    ended: (payload.readUInt8(1) & 0x80) !== 0
  };
}

export function buildTelephoneEvent(digit: string, durationMs: number, ended: boolean): Buffer {
  const code = Object.entries(TELEPHONY_EVENTS).find(([, value]) => value === digit)?.[0];
  if (code === undefined) return Buffer.alloc(0);
  const payload = Buffer.alloc(4);
  payload.writeUInt8(Number(code), 0);
  payload.writeUInt8((ended ? 0x80 : 0) | 10, 1);
  payload.writeUInt16BE(Math.max(0, Math.min(32767, Math.round(durationMs / 20))), 2);
  return payload;
}

const TELEPHONY_EVENTS: Record<number, string> = {
  0: '0',
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '*',
  11: '#',
  12: 'A',
  13: 'B',
  14: 'C',
  15: 'D'
};
