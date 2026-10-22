import { WebSocket } from 'ws';
import { MediaStreamTrack, RTCPeerConnection, useOPUS } from 'werift';
import { makeWsUrl } from '@openmeet/shared';
import type {
  ChatMessage,
  ClientMessage,
  IceConfig,
  JoinResponse,
  MediaState,
  Participant,
  RoomView,
  ServerMessage,
  SignalData
} from '@openmeet/shared';
import { opusPayload } from './opus.js';
import { makeRtpPacket } from './rtp.js';

export interface ParticipantOptions {
  serverUrl: string;
  roomCode: string;
  displayName: string;
  password?: string;
  inviteToken?: string;
  accessToken?: string;
}

export interface ParticipantEvents {
  /** Opus payload from a remote participant, before any transcoding. */
  onRemoteAudio?: (payload: Uint8Array, peerId: string) => void;
  onRoom?: (room: RoomView, participants: Participant[]) => void;
  onChat?: (message: ChatMessage) => void;
  onEnded?: (reason: string) => void;
  onFatal?: (message: string) => void;
}

interface PeerWrapper {
  peerId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

const PING_INTERVAL_MS = 25_000;

/**
 * Joins an OpenMeet room as an ordinary participant using the WebRTC stack in
 * Node, so a telephony caller appears in the mesh like any other member.
 */
export class RoomParticipant {
  readonly track: MediaStreamTrack;
  private readonly options: ParticipantOptions;
  private readonly events: ParticipantEvents;
  private readonly peers = new Map<string, PeerWrapper>();
  private ws: WebSocket | null = null;
  private ticket: string | null = null;
  private ice: IceConfig = { iceServers: [] };
  private selfId = '';
  private room: RoomView | null = null;
  private readonly opusPayloadType: number = useOPUS().payloadType;
  private pingTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private started = false;

  private constructor(options: ParticipantOptions, events: ParticipantEvents) {
    this.options = options;
    this.events = events;
    this.track = new MediaStreamTrack({ kind: 'audio' });
  }

  get participantId(): string {
    return this.selfId;
  }

  static async join(options: ParticipantOptions, events: ParticipantEvents = {}): Promise<RoomParticipant> {
    const participant = new RoomParticipant(options, events);
    await participant.start();
    return participant;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const url = `${this.options.serverUrl.replace(/\/$/, '')}/api/rooms/${encodeURIComponent(this.options.roomCode)}/join`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.accessToken ? { authorization: `Bearer ${this.options.accessToken}` } : {})
      },
      body: JSON.stringify({
        displayName: this.options.displayName,
        ...(this.options.password ? { password: this.options.password } : {}),
        ...(this.options.inviteToken ? { inviteToken: this.options.inviteToken } : {})
      })
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    } & Partial<JoinResponse>;
    if (!response.ok || !payload.ticket) {
      throw new Error(payload.error?.message ?? `加入房间失败 (${response.status})`);
    }
    const accepted: JoinResponse = {
      ticket: payload.ticket,
      room: payload.room as RoomView,
      self: payload.self as JoinResponse['self'],
      ice: payload.ice ?? { iceServers: [] }
    };
    this.ticket = accepted.ticket;
    this.ice = accepted.ice;
    this.room = accepted.room;
    this.openSocket(accepted);
  }

  private openSocket(join: JoinResponse): void {
    if (this.closed) return;
    const socket = new WebSocket(makeWsUrl(this.options.serverUrl));
    this.ws = socket;
    socket.on('open', () => {
      this.send({ type: 'hello', v: 1, ticket: this.ticket ?? '' });
      this.startPing();
    });
    socket.on('message', (data) => this.onMessage(String(data), join));
    socket.on('close', () => {
      if (!this.closed) this.events.onFatal?.('信令连接已断开');
    });
    socket.on('error', () => {
      if (!this.closed) this.events.onFatal?.('信令连接错误');
    });
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private onMessage(raw: string, join: JoinResponse): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'welcome': {
        this.selfId = message.self.peerId;
        this.room = message.room;
        this.events.onRoom?.(message.room, message.participants);
        this.ensurePeers(message.participants);
        break;
      }
      case 'admitted':
        this.room = message.room;
        this.events.onRoom?.(message.room, message.participants);
        this.ensurePeers(message.participants);
        break;
      case 'peer.join':
        this.events.onRoom?.(this.room ?? join.room, [message.peer]);
        this.ensurePeer(message.peer);
        break;
      case 'peer.leave':
        this.removePeer(message.peerId);
        break;
      case 'room.update':
        this.room = message.room;
        this.events.onRoom?.(message.room, []);
        break;
      case 'signal':
        void this.handleSignal(message.from, message.data);
        break;
      case 'chat':
        this.events.onChat?.(message.message);
        break;
      case 'room.ended':
        this.events.onEnded?.(message.reason);
        this.close();
        break;
      case 'moderation':
        if (message.action === 'kicked') this.close();
        break;
      default:
        break;
    }
  }

  private ensurePeers(participants: Participant[]): void {
    for (const participant of participants) this.ensurePeer(participant);
  }

  private ensurePeer(participant: Participant): void {
    if (!this.selfId || participant.peerId === this.selfId) return;
    if (this.peers.has(participant.peerId)) return;
    const pc = new RTCPeerConnection({
      iceServers: this.ice.iceServers.map((server) => ({
        urls: server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {})
      })),
      codecs: { audio: [useOPUS()] }
    });
    const wrapper: PeerWrapper = {
      peerId: participant.peerId,
      pc,
      polite: this.selfId < participant.peerId,
      makingOffer: false,
      ignoreOffer: false
    };
    this.peers.set(participant.peerId, wrapper);

    pc.addTrack(this.track);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate) return;
      this.send({
        type: 'signal',
        to: participant.peerId,
        data: {
          kind: 'candidate',
          candidate: {
            candidate: candidate.toJSON().candidate as string,
            sdpMid: candidate.toJSON().sdpMid ?? null,
            sdpMLineIndex: candidate.toJSON().sdpMLineIndex ?? null,
            usernameFragment: null
          }
        }
      });
    };

    pc.onnegotiationneeded = async () => {
      if (this.closed) return;
      if (wrapper.polite && !pc.remoteDescription) return;
      if (pc.signalingState !== 'stable' || wrapper.makingOffer) return;
      try {
        wrapper.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.send({
            type: 'signal',
            to: participant.peerId,
            data: { kind: 'offer', sdp: pc.localDescription.sdp }
          });
        }
      } catch {
        // a later negotiation cycle can recover
      } finally {
        wrapper.makingOffer = false;
      }
    };

    pc.ontrack = (event) => {
      event.track.onReceiveRtp.subscribe((packet) => {
        this.events.onRemoteAudio?.(opusPayload(packet), participant.peerId);
      });
    };
  }

  private async handleSignal(from: string, data: SignalData): Promise<void> {
    const wrapper = this.peers.get(from);
    if (!wrapper) return;
    const pc = wrapper.pc;
    try {
      if (data.kind === 'candidate') {
        if (!pc.remoteDescription) return;
        await pc.addIceCandidate(data.candidate as never);
        return;
      }
      if (data.kind === 'offer') {
        const colliding = wrapper.makingOffer || pc.signalingState !== 'stable';
        if (!wrapper.polite && colliding) {
          wrapper.ignoreOffer = true;
          return;
        }
        wrapper.ignoreOffer = false;
        if (colliding) {
          await pc.setLocalDescription({ type: 'rollback' } as never);
        }
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        this.send({
          type: 'signal',
          to: from,
          data: { kind: 'answer', sdp: pc.localDescription?.sdp ?? '' }
        });
      } else if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      }
    } catch {
      // SDP errors surface through connection state transitions
    }
  }

  /** Feed one 20 ms Opus frame from the telephony side into the room. */
  writeAudio(payload: Uint8Array): void {
    if (this.closed) return;
    this.sequence = (this.sequence + 1) % 65536;
    // 48 kHz clock, one 20 ms frame per packet
    this.timestamp = (this.timestamp + 960) % 2 ** 32;
    this.track.writeRtp(makeRtpPacket(this.opusPayloadType, this.sequence, this.timestamp, this.ssrc, Buffer.from(payload)));
  }

  sendChat(text: string): void {
    this.send({ type: 'chat', text, clientId: `gw-${Date.now()}` });
  }

  setMuted(muted: boolean): void {
    const state: MediaState = { mic: !muted, camera: false, screen: false, handRaised: false };
    this.send({ type: 'media', state });
  }

  private sequence = Math.floor(Math.random() * 65535);
  private timestamp = Math.floor(Math.random() * 2 ** 31);
  private ssrc = Math.floor(Math.random() * 2 ** 31);

  private removePeer(peerId: string): void {
    const wrapper = this.peers.get(peerId);
    if (!wrapper) return;
    wrapper.pc.close();
    this.peers.delete(peerId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.send({ type: 'room.leave' });
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    try {
      this.ws?.close();
    } catch {
      // already closing
    }
    this.ws = null;
    this.track.stop();
  }
}
