import {
  PING_INTERVAL_MS,
  WS_CLOSE,
  parseServerMessage
} from '@openmeet/shared';
import type {
  ChatMessage,
  ClientMessage,
  IceConfig,
  MediaState,
  Participant,
  PeerLeaveReason,
  PendingJoin,
  Role,
  RoomEndReason,
  RoomView,
  ServerMessage,
  SignalData,
  WelcomeSelf
} from '@openmeet/shared';

export interface RemoteStreams {
  audio: MediaStream | null;
  camera: MediaStream | null;
  screen: MediaStream | null;
}

export interface WelcomeInfo {
  self: WelcomeSelf;
  room: RoomView;
  participants: Participant[];
  pending: PendingJoin[];
  admitted: boolean;
}

export interface MeetingClientCallbacks {
  onConnection(status: 'connecting' | 'connected' | 'reconnecting', attempt?: number): void;
  onWelcome(info: WelcomeInfo): void;
  onAdmitted(room: RoomView, participants: Participant[]): void;
  onPeerJoined(peer: Participant): void;
  onPeerLeft(peerId: string, reason: PeerLeaveReason): void;
  onPeerUpdated(peerId: string, state: MediaState, role?: Role): void;
  onRemoteStream(peerId: string, streams: RemoteStreams): void;
  onLocalStream(stream: MediaStream | null): void;
  onLocalScreen(stream: MediaStream | null): void;
  onRoomUpdate(room: RoomView): void;
  onChat(message: ChatMessage): void;
  onPending(pending: PendingJoin[]): void;
  onLobbyRequest(peer: PendingJoin): void;
  onLobbyDenied(reason?: string): void;
  onModeration(message: Extract<ServerMessage, { type: 'moderation' }>): void;
  onSelfRole(role: Role): void;
  onEnded(reason: RoomEndReason, byName?: string): void;
  onFatal(message: string): void;
  onError(code: string, message: string): void;
}

export interface MeetingClientOptions {
  wsUrl: string;
  ticket: string;
  iceConfig: IceConfig;
  localStream: MediaStream | null;
  initialMediaState?: MediaState;
  callbacks: MeetingClientCallbacks;
}

interface PeerWrapper {
  peerId: string;
  name: string;
  pc: RTCPeerConnection;
  audioTx: RTCRtpTransceiver;
  videoTx: RTCRtpTransceiver;
  screenTx: RTCRtpTransceiver;
  slotByTx: Map<RTCRtpTransceiver, keyof RemoteStreams>;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  restartAt: number;
  streams: RemoteStreams;
}

const EMPTY_STATE: MediaState = { mic: false, camera: false, screen: false, handRaised: false };

export class MeetingClient {
  private readonly options: MeetingClientOptions;
  private readonly callbacks: MeetingClientCallbacks;
  private ws: WebSocket | null = null;
  private peers = new Map<string, PeerWrapper>();
  private selfPeerId: string | null = null;
  private selfRole: Role = 'participant';
  private admitted = false;
  private closedByUser = false;
  private ended = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private localStream: MediaStream | null;
  private audioTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private media: MediaState;

  constructor(options: MeetingClientOptions) {
    this.options = options;
    this.callbacks = options.callbacks;
    this.localStream = options.localStream;
    this.audioTrack = options.localStream?.getAudioTracks()[0] ?? null;
    this.cameraTrack = options.localStream?.getVideoTracks()[0] ?? null;
    this.media = {
      ...EMPTY_STATE,
      mic: options.initialMediaState?.mic ?? Boolean(this.audioTrack?.enabled),
      camera: options.initialMediaState?.camera ?? Boolean(this.cameraTrack?.enabled),
      handRaised: options.initialMediaState?.handRaised ?? false
    };
    this.openSocket();
  }

  get isAdmitted(): boolean {
    return this.admitted;
  }

  get selfId(): string | null {
    return this.selfPeerId;
  }

  connect(): void {
    if (!this.ws) this.openSocket();
  }

  private openSocket(): void {
    if (this.closedByUser || this.ended) return;
    this.callbacks.onConnection(
      this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting',
      this.reconnectAttempts
    );
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.send({ type: 'hello', v: 1, ticket: this.options.ticket });
      this.startPing();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const message = parseServerMessage(raw);
      if (!message) return;
      this.handleMessage(message);
    };

    socket.onclose = (event) => {
      this.stopPing();
      if (this.ws !== socket) return;
      this.ws = null;
      this.teardownPeers();
      if (this.closedByUser || this.ended) return;

      if (
        event.code === WS_CLOSE.roomClosed ||
        event.code === WS_CLOSE.removed ||
        event.code === WS_CLOSE.auth ||
        event.code === WS_CLOSE.protocol ||
        event.code === WS_CLOSE.rateLimited ||
        event.code === WS_CLOSE.serverShutdown ||
        event.code === WS_CLOSE.badState
      ) {
        this.ended = true;
        const fatalLabels: Record<number, string> = {
          [WS_CLOSE.roomClosed]: '会议已结束',
          [WS_CLOSE.removed]: '你已被移出会议',
          [WS_CLOSE.auth]: '入会凭证已失效，请重新加入',
          [WS_CLOSE.protocol]: '协议不兼容，请升级客户端',
          [WS_CLOSE.rateLimited]: '连接过于频繁，请稍后再试',
          [WS_CLOSE.serverShutdown]: '服务器已关闭',
          [WS_CLOSE.badState]: '连接状态异常，请重新加入'
        };
        this.callbacks.onFatal(fatalLabels[event.code] ?? event.reason ?? '连接已关闭，会议可能已结束');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose drives reconnect policy.
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.ended || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(12_000, 600 * 2 ** Math.min(this.reconnectAttempts - 1, 4));
    this.callbacks.onConnection('reconnecting', this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private sendSignal(to: string, data: SignalData): void {
    this.send({ type: 'signal', to, data });
  }

  private sendMediaState(): void {
    if (this.admitted) this.send({ type: 'media', state: { ...this.media } });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        this.selfPeerId = message.self.peerId;
        this.selfRole = message.self.role;
        this.admitted = message.admitted;
        this.reconnectAttempts = 0;
        this.teardownPeers();
        if (message.admitted) this.ensurePeers(message.participants);
        this.callbacks.onConnection('connected');
        this.callbacks.onWelcome({
          self: message.self,
          room: message.room,
          participants: message.participants,
          pending: message.pending,
          admitted: message.admitted
        });
        if (message.admitted) this.sendMediaState();
        break;
      }
      case 'admitted':
        this.admitted = true;
        this.ensurePeers(message.participants);
        this.callbacks.onAdmitted(message.room, message.participants);
        this.sendMediaState();
        break;
      case 'peer.join':
        this.ensurePeers([message.peer]);
        this.callbacks.onPeerJoined(message.peer);
        break;
      case 'peer.leave':
        this.removePeer(message.peerId);
        this.callbacks.onPeerLeft(message.peerId, message.reason);
        break;
      case 'peer.update':
        if (message.peerId === this.selfPeerId && message.role) {
          this.selfRole = message.role;
          this.callbacks.onSelfRole(message.role);
        }
        this.callbacks.onPeerUpdated(message.peerId, message.state, message.role);
        break;
      case 'room.update':
        this.callbacks.onRoomUpdate(message.room);
        break;
      case 'signal':
        void this.handleSignal(message.from, message.data);
        break;
      case 'chat':
        this.callbacks.onChat(message.message);
        break;
      case 'lobby.request':
        this.callbacks.onLobbyRequest(message.peer);
        break;
      case 'lobby.update':
        this.callbacks.onPending(message.pending);
        break;
      case 'lobby.denied':
        this.callbacks.onLobbyDenied(message.reason);
        break;
      case 'moderation':
        if (message.action === 'muted' && this.audioTrack) {
          this.audioTrack.enabled = false;
          this.media.mic = false;
        }
        if (message.action === 'role' && message.role) {
          this.selfRole = message.role;
          this.callbacks.onSelfRole(message.role);
        }
        this.callbacks.onModeration(message);
        break;
      case 'room.ended':
        this.ended = true;
        this.teardownPeers();
        this.callbacks.onEnded(message.reason, message.byName);
        this.disposeSocket();
        break;
      case 'error':
        this.callbacks.onError(message.code, message.message);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private ensurePeers(participants: Participant[]): void {
    for (const participant of participants) this.ensurePeer(participant);
  }

  private ensurePeer(participant: Participant): void {
    if (!this.selfPeerId || this.peers.has(participant.peerId)) return;
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceConfig.iceServers,
      iceTransportPolicy: this.options.iceConfig.iceTransportPolicy ?? 'all'
    });
    const audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    const screenTx = pc.addTransceiver('video', { direction: 'sendrecv' });

    if (this.audioTrack) {
      void audioTx.sender.replaceTrack(this.audioTrack);
      if (this.localStream) audioTx.sender.setStreams(this.localStream);
    }
    if (this.cameraTrack) {
      void videoTx.sender.replaceTrack(this.cameraTrack);
      if (this.localStream) videoTx.sender.setStreams(this.localStream);
    }
    if (this.screenTrack && this.screenStream) {
      void screenTx.sender.replaceTrack(this.screenTrack);
      screenTx.sender.setStreams(this.screenStream);
    }

    const wrapper: PeerWrapper = {
      peerId: participant.peerId,
      name: participant.name,
      pc,
      audioTx,
      videoTx,
      screenTx,
      slotByTx: new Map(),
      polite: this.selfPeerId < participant.peerId,
      makingOffer: false,
      ignoreOffer: false,
      restartAt: 0,
      streams: { audio: null, camera: null, screen: null }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.sendSignal(participant.peerId, {
        kind: 'candidate',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment
        }
      });
    };

    pc.onnegotiationneeded = async () => {
      if (this.closedByUser || this.ended) return;
      if (wrapper.polite && !pc.remoteDescription) return;
      if (pc.signalingState !== 'stable' || wrapper.makingOffer) return;
      try {
        wrapper.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.sendSignal(participant.peerId, { kind: 'offer', sdp: pc.localDescription.sdp });
        }
      } catch {
        // A later negotiation cycle can recover; reconnection rebuilds peers.
      } finally {
        wrapper.makingOffer = false;
      }
    };

    pc.ontrack = (event) => this.handleRemoteTrack(wrapper, participant.peerId, event);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed') return;
      const now = Date.now();
      if (now - wrapper.restartAt < 10_000) return;
      wrapper.restartAt = now;
      try {
        pc.restartIce();
      } catch {
        // best effort
      }
    };

    this.peers.set(participant.peerId, wrapper);
  }

  private handleRemoteTrack(
    wrapper: PeerWrapper,
    peerId: string,
    event: RTCTrackEvent
  ): void {
    const slot = this.resolveRemoteSlot(wrapper, event.transceiver, event.track);
    const shared = event.streams[0];
    const apply = (track: MediaStreamTrack): void => {
      // Screen has no audio partner to stay in sync with, and a transceiver
      // negotiated without a track advertises msid "-", whose stream may not
      // contain the track that later carries media.
      wrapper.streams[slot] =
        slot === 'camera' && shared && shared.getTracks().includes(track)
          ? shared
          : new MediaStream([track]);
      this.callbacks.onRemoteStream(peerId, { ...wrapper.streams });
    };
    const track = event.transceiver.receiver.track ?? event.track;
    apply(track);
    track.addEventListener(
      'ended',
      () => {
        const next = event.transceiver.receiver.track;
        if (next && next !== track && next.readyState === 'live') apply(next);
      },
      { once: true }
    );
  }

  private syncRemoteTracks(wrapper: PeerWrapper): void {
    let changed = false;
    for (const [transceiver, slot] of wrapper.slotByTx) {
      const current = wrapper.streams[slot];
      if (current && current.getTracks().some((track) => track.readyState === 'live')) continue;
      const track = transceiver.receiver.track;
      if (!track || track.readyState !== 'live') continue;
      wrapper.streams[slot] = new MediaStream([track]);
      changed = true;
    }
    if (changed) this.callbacks.onRemoteStream(wrapper.peerId, { ...wrapper.streams });
  }

  private resolveRemoteSlot(
    wrapper: PeerWrapper,
    transceiver: RTCRtpTransceiver,
    track: MediaStreamTrack
  ): keyof RemoteStreams {
    const known = wrapper.slotByTx.get(transceiver);
    if (known) return known;
    const taken = new Set(wrapper.slotByTx.values());
    const slot: keyof RemoteStreams =
      track.kind === 'audio' ? 'audio' : taken.has('camera') ? 'screen' : 'camera';
    wrapper.slotByTx.set(transceiver, slot);
    return slot;
  }

  private async handleSignal(from: string, data: SignalData): Promise<void> {
    const wrapper = this.peers.get(from);
    if (!wrapper) return;
    const pc = wrapper.pc;
    try {
      if (data.kind === 'candidate') {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch {
          if (!wrapper.ignoreOffer) {
            // Candidate may arrive before the remote description; ignore safely.
          }
        }
        return;
      }
      const description: RTCSessionDescriptionInit = { type: data.kind, sdp: data.sdp };
      if (data.kind === 'offer') {
        const colliding = wrapper.makingOffer || pc.signalingState !== 'stable';
        if (!wrapper.polite && colliding) {
          wrapper.ignoreOffer = true;
          return;
        }
        wrapper.ignoreOffer = false;
        if (colliding) {
          await pc.setLocalDescription({ type: 'rollback' } as RTCLocalSessionDescriptionInit);
        }
        await pc.setRemoteDescription(description);
        await pc.setLocalDescription();
        this.syncRemoteTracks(wrapper);
        if (pc.localDescription) {
          this.sendSignal(from, { kind: 'answer', sdp: pc.localDescription.sdp });
        }
      } else {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(description);
          this.syncRemoteTracks(wrapper);
        }
      }
    } catch {
      // SDP failures are retried through ICE restart or reconnect.
    }
  }

  private removePeer(peerId: string): void {
    const wrapper = this.peers.get(peerId);
    if (!wrapper) return;
    wrapper.pc.onicecandidate = null;
    wrapper.pc.onnegotiationneeded = null;
    wrapper.pc.ontrack = null;
    wrapper.pc.close();
    this.peers.delete(peerId);
  }

  private teardownPeers(): void {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
  }

  private ensureLocalStream(): MediaStream {
    if (!this.localStream) this.localStream = new MediaStream();
    return this.localStream;
  }

  private attachTrack(track: MediaStreamTrack): void {
    const stream = this.ensureLocalStream();
    if (!stream.getTracks().includes(track)) stream.addTrack(track);
    for (const wrapper of this.peers.values()) {
      const sender =
        track.kind === 'audio' ? wrapper.audioTx.sender : wrapper.videoTx.sender;
      void sender.replaceTrack(track);
      sender.setStreams(stream);
    }
    this.callbacks.onLocalStream(stream);
  }

  async setMicrophone(enabled: boolean, deviceId?: string): Promise<boolean> {
    if (!enabled) {
      if (this.audioTrack) this.audioTrack.enabled = false;
      this.media.mic = false;
      this.sendMediaState();
      return false;
    }
    if (!this.audioTrack) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true
        });
        const track = stream.getAudioTracks()[0] ?? null;
        if (!track) return false;
        this.audioTrack = track;
        this.attachTrack(track);
      } catch {
        return false;
      }
    }
    this.audioTrack.enabled = true;
    this.media.mic = true;
    this.sendMediaState();
    return true;
  }

  async setCamera(enabled: boolean, deviceId?: string): Promise<boolean> {
    if (!enabled) {
      if (this.cameraTrack) this.cameraTrack.enabled = false;
      this.media.camera = false;
      this.sendMediaState();
      return false;
    }
    if (!this.cameraTrack) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true
        });
        const track = stream.getVideoTracks()[0] ?? null;
        if (!track) return false;
        this.cameraTrack = track;
        this.attachTrack(track);
      } catch {
        return false;
      }
    }
    this.cameraTrack.enabled = true;
    this.media.camera = true;
    this.sendMediaState();
    return true;
  }

  async startScreenShare(): Promise<boolean> {
    if (this.screenTrack) return true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      return false;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      return false;
    }
    this.screenStream = stream;
    this.screenTrack = track;
    track.onended = () => {
      void this.stopScreenShare();
    };
    for (const wrapper of this.peers.values()) {
      void wrapper.screenTx.sender.replaceTrack(track);
      wrapper.screenTx.sender.setStreams(stream);
    }
    this.media.screen = true;
    this.sendMediaState();
    this.callbacks.onLocalScreen(stream);
    return true;
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenTrack) return;
    const track = this.screenTrack;
    this.screenTrack = null;
    this.screenStream = null;
    for (const wrapper of this.peers.values()) {
      void wrapper.screenTx.sender.replaceTrack(null);
    }
    track.onended = null;
    track.stop();
    this.media.screen = false;
    this.sendMediaState();
    this.callbacks.onLocalScreen(null);
  }

  setHandRaised(raised: boolean): void {
    this.media.handRaised = raised;
    this.sendMediaState();
  }

  sendChat(text: string, clientId: string): boolean {
    return this.send({ type: 'chat', text, clientId });
  }

  admit(peerId: string): void {
    this.send({ type: 'lobby.admit', peerId });
  }

  deny(peerId: string): void {
    this.send({ type: 'lobby.deny', peerId });
  }

  lock(locked: boolean): void {
    this.send({ type: 'room.lock', locked });
  }

  kick(peerId: string): void {
    this.send({ type: 'room.kick', peerId });
  }

  mute(peerId: string): void {
    this.send({ type: 'room.mute', peerId });
  }

  setRole(peerId: string, role: 'cohost' | 'participant'): void {
    this.send({ type: 'room.role', peerId, role });
  }

  endRoom(): void {
    this.send({ type: 'room.end' });
  }

  leave(sendLeave = true): void {
    if (this.closedByUser) return;
    if (sendLeave && !this.ended) this.send({ type: 'room.leave' });
    this.closedByUser = true;
    this.teardownPeers();
    this.disposeSocket();
    this.stopLocalMedia();
  }

  dispose(): void {
    this.leave(true);
  }

  private disposeSocket(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'client closing');
      } catch {
        // ignore
      }
    }
  }

  private stopLocalMedia(): void {
    if (this.screenTrack || this.screenStream) this.callbacks.onLocalScreen(null);
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.screenStream = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.audioTrack = null;
    this.cameraTrack = null;
    this.media = { ...EMPTY_STATE };
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getMediaState(): MediaState {
    return { ...this.media };
  }

  getSelfRole(): Role {
    return this.selfRole;
  }
}

