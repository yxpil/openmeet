import { createSocket, type Socket } from 'node:dgram';
import {
  EmitterImpl,
  Inviter,
  Invitation,
  SessionState,
  TransportState,
  UserAgent,
  type UserAgentDelegate
} from 'sip.js';
import {
  buildAudioSdp,
  offeredCodecs,
  parseSdp,
  pickAudioSection,
  type AudioCodecSelection
} from './sdp.js';
import {
  RtpEndpoint,
  buildTelephoneEvent,
  makeRtpPacket,
  parseTelephoneEvent,
  type RtpTarget
} from './rtp.js';
import { extractCallId, rememberCalledNumber, rewriteRequestLine, takeCalledNumber } from './ruri.js';

export interface SipTransportOptions {
  listenAddress: string;
  listenPort: number;
  /** User part of this UA's address of record; inbound R-URIs are rewritten to it. */
  aorUser?: string;
  /** Next hop: the PBX, provider or hardphone the gateway speaks SIP with. */
  peer: RtpTarget;
}

/**
 * sip.js ships only a WebSocket transport, but trunks speak UDP. The UA only
 * needs `protocol`, `send`, and the three callbacks, so this is the whole
 * adapter; datagrams are handed straight to the parser.
 */
export class UdpTransport {
  protocol = 'UDP';
  onConnect: (() => void) | undefined;
  onDisconnect: ((error?: Error) => void) | undefined;
  onMessage: ((message: string) => void) | undefined;
  /** sip.js observes these alongside the onConnect/onDisconnect callbacks. */
  readonly stateChange = new EmitterImpl<TransportState>();
  private readonly socket: Socket;
  private readonly options: SipTransportOptions;
  private _state: TransportState = TransportState.Disconnected;

  constructor(_logger: unknown, options: SipTransportOptions) {
    this.options = options;
    this.socket = createSocket('udp4');
    this.socket.on('message', (data) => {
      let text = data.toString('utf8');
      const aorUser = this.options.aorUser;
      if (aorUser) {
        const boundary = text.indexOf('\r\n');
        const firstLine = boundary < 0 ? text : text.slice(0, boundary);
        const rewritten = rewriteRequestLine(firstLine, aorUser);
        if (rewritten.called) {
          rememberCalledNumber(extractCallId(text), rewritten.called);
        }
        if (rewritten.line !== firstLine) text = rewritten.line + text.slice(boundary);
      }
      this.onMessage?.(text);
    });
    this.socket.on('error', (error) => {
      this.setState(TransportState.Disconnected);
      this.onDisconnect?.(error);
    });
  }

  get state(): TransportState {
    return this._state;
  }

  get readyState(): number {
    return this._state === TransportState.Connected ? 1 : 0;
  }

  isConnected(): boolean {
    return this._state === TransportState.Connected;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.options.listenPort, this.options.listenAddress, () => {
        this.socket.removeListener('error', reject);
        this.setState(TransportState.Connected);
        this.onConnect?.();
        resolve();
      });
    });
  }

  send(message: string): Promise<void> {
    const { peer } = this.options;
    return new Promise((resolve, reject) => {
      this.socket.send(Buffer.from(message, 'utf8'), peer.port, peer.address, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }

  async disconnect(): Promise<void> {
    this.setState(TransportState.Disconnected);
    this.onDisconnect?.();
  }

  async dispose(): Promise<void> {
    this.socket.close();
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    this.stateChange.emit(next);
  }
}

export interface SelectedCodec extends AudioCodecSelection {
  telephoneEventPayload?: number;
}

/**
 * Pick the codec both legs can share. Opus at 48 kHz is preferred because it
 * then passes through to the WebRTC leg untouched; G.711 is the fallback and
 * costs a transcode on every frame.
 */
export function selectCodec(offer: AudioCodecSelection[]): SelectedCodec | null {
  const telephone = offer.find((codec) => codec.encodingName === 'TELEPHONE_EVENT');
  const preferred =
    offer.find((codec) => codec.encodingName === 'OPUS' && codec.clockRate === 48000) ??
    offer.find((codec) => codec.encodingName === 'PCMU') ??
    offer.find((codec) => codec.encodingName === 'PCMA');
  if (!preferred) return null;
  return { ...preferred, telephoneEventPayload: telephone?.payloadType };
}

export interface SdhEvents {
  onRtp?: (payload: Uint8Array, marker: boolean) => void;
  onDtmf?: (digit: string, durationMs: number) => void;
}

/**
 * The session description handler sip.js drives. It owns the RTP endpoint and
 * the codec choice, which keeps SDP parsing, media binding and DTMF in one
 * place instead of spread across the dialog code.
 */
export class GatewaySessionDescriptionHandler {
  /** The sip.js Session (Invitation/Inviter) that owns this handler. */
  readonly session: unknown;
  private readonly listenAddress: string;
  private readonly events: SdhEvents;
  private endpoint: RtpEndpoint | null = null;
  private codec: SelectedCodec | null = null;
  private sequence = Math.floor(Math.random() * 65535);
  private timestamp = Math.floor(Math.random() * 2 ** 31);
  private readonly ssrc = Math.floor(Math.random() * 2 ** 31);
  private closed = false;

  constructor(session: unknown, options: { listenAddress: string; events?: SdhEvents }) {
    this.session = session;
    this.listenAddress = options.listenAddress;
    this.events = options.events ?? {};
  }

  get mediaCodec(): SelectedCodec | null {
    return this.codec;
  }

  get port(): number | null {
    return this.endpoint?.port ?? null;
  }

  get peer(): RtpTarget | null {
    return this.endpoint?.peerAddress ?? null;
  }

  hasDescription(contentType: string): boolean {
    return contentType === 'application/sdp';
  }

  /** sip.js calls this for both our offer and our answer. */
  async getDescription(
    _options?: unknown,
    _modifiers?: unknown[]
  ): Promise<{ body: string; contentType: string }> {
    if (!this.endpoint) {
      this.endpoint = await RtpEndpoint.create({ port: 0, address: this.listenAddress });
      this.endpoint.onPacket((packet) => this.onIncoming(packet));
    }
    const codecs = this.codec
      ? [
          {
            payloadType: this.codec.payloadType,
            encodingName: this.codec.encodingName,
            clockRate: this.codec.clockRate,
            channels: this.codec.channels,
            fmtp: this.codec.fmtp
          },
          ...(this.codec.telephoneEventPayload
            ? [
                {
                  payloadType: this.codec.telephoneEventPayload,
                  encodingName: 'telephone-event',
                  clockRate: 8000,
                  fmtp: '0-15'
                }
              ]
            : [])
        ]
      : [
          { payloadType: 96, encodingName: 'opus', clockRate: 48000, channels: 2, fmtp: 'minptime=20;useinbandfec=1' },
          { payloadType: 0, encodingName: 'PCMU', clockRate: 8000 },
          { payloadType: 8, encodingName: 'PCMA', clockRate: 8000 },
          { payloadType: 101, encodingName: 'telephone-event', clockRate: 8000, fmtp: '0-15' }
        ];
    return {
      body: buildAudioSdp({
        port: this.endpoint.port,
        address: this.listenAddress,
        codecs,
        sessionName: 'openmeet'
      }),
      contentType: 'application/sdp'
    };
  }

  /** Learn the remote media address and the agreed codec. */
  async setDescription(sdp: string): Promise<void> {
    const parsed = parseSdp(sdp);
    const audio = pickAudioSection(parsed);
    if (!audio) throw new Error('SDP 中没有音频段');
    const codec = selectCodec(offeredCodecs(parsed));
    if (!codec) throw new Error('没有共同支持的音频编码');
    this.codec = codec;
    const address = audio.connectionIp ?? parsed.connectionIp ?? '0.0.0.0';
    if (!this.endpoint) {
      this.endpoint = await RtpEndpoint.create({ port: 0, address: this.listenAddress });
      this.endpoint.onPacket((packet) => this.onIncoming(packet));
    }
    this.endpoint.setPeer({ address, port: audio.port });
  }

  sendAudio(payload: Uint8Array, marker = false): boolean {
    if (!this.endpoint || !this.codec || this.closed) return false;
    this.sequence = (this.sequence + 1) % 65536;
    const step = this.codec.clockRate === 48000 ? 960 : 160;
    this.timestamp = (this.timestamp + step) % 2 ** 32;
    return this.endpoint.send(
      makeRtpPacket(
        this.codec.payloadType,
        this.sequence,
        this.timestamp,
        this.ssrc,
        Buffer.from(payload),
        marker
      )
    );
  }

  /** RFC 2833 needs an onset packet and an end-of-event packet. */
  sendDtmf(tones: string): boolean {
    const payloadType = this.codec?.telephoneEventPayload;
    if (!payloadType || !this.endpoint) return false;
    for (const digit of tones) {
      const onset = buildTelephoneEvent(digit, 80, false);
      const offset = buildTelephoneEvent(digit, 160, true);
      if (onset.length === 0) return false;
      this.sequence = (this.sequence + 1) % 65536;
      this.endpoint.send(makeRtpPacket(payloadType, this.sequence, this.timestamp, this.ssrc, onset));
      this.sequence = (this.sequence + 1) % 65536;
      this.endpoint.send(
        makeRtpPacket(payloadType, this.sequence, this.timestamp, this.ssrc, offset, true)
      );
    }
    return true;
  }

  private onIncoming(packet: { header: { payloadType: number; marker: boolean }; payload: Buffer }): void {
    if (!this.codec) return;
    if (packet.header.payloadType === this.codec.telephoneEventPayload) {
      const event = parseTelephoneEvent(packet.payload);
      if (event) this.events.onDtmf?.(event.digit, event.durationMs);
      return;
    }
    if (packet.header.payloadType !== this.codec.payloadType) return;
    this.events.onRtp?.(
      new Uint8Array(packet.payload.buffer, packet.payload.byteOffset, packet.payload.length),
      packet.header.marker
    );
  }

  /** sip.js also calls these two; the gateway has no local media to hold. */
  async updateOptions(): Promise<void> {
    return undefined;
  }

  resetOptions(): void {
    // no-op
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endpoint?.close();
    this.endpoint = null;
  }
}

export interface SipEndpointOptions extends SipTransportOptions {
  /** SIP uri the gateway identifies with, e.g. sip:gateway@10.0.0.9:5080 */
  uri: string;
  displayName?: string;
}

export interface CallContext {
  session: SipCall;
  caller: string;
}

/** One SIP dialog, with the media handler resolved for the bridge. */
export class SipCall {
  private readonly invitation: Invitation | null;
  private readonly inviter: Inviter | null;
  private attached: GatewaySessionDescriptionHandler | null = null;
  private closed = false;

  constructor(invitation: Invitation | null, inviter: Inviter | null) {
    this.invitation = invitation;
    this.inviter = inviter;
  }

  /** Bound by the session description handler factory once sip.js creates it. */
  attach(handler: GatewaySessionDescriptionHandler): void {
    this.attached = handler;
  }

  get handler(): GatewaySessionDescriptionHandler | null {
    if (this.attached) return this.attached;
    const session = this.invitation ?? this.inviter;
    return (session?.sessionDescriptionHandler as GatewaySessionDescriptionHandler) ?? null;
  }

  get remoteSdp(): string {
    return this.invitation?.request.body ?? '';
  }

  get direction(): 'inbound' | 'outbound' {
    return this.invitation ? 'inbound' : 'outbound';
  }

  get caller(): string {
    return this.invitation?.remoteIdentity.uri.user ?? '';
  }

  /** The dialled number, recovered before the transport rewrote the R-URI. */
  get called(): string {
    const callId = this.invitation?.request.callId ?? this.inviter?.request.callId;
    return takeCalledNumber(callId) || this.invitation?.request.ruri?.user || '';
  }

  async accept(): Promise<void> {
    if (!this.invitation) throw new Error('只入呼可以 accept');
    await this.invitation.accept();
  }

  async progress(): Promise<void> {
    await this.invitation?.progress();
  }

  /**
   * Refuse the dialog. Once a call is established a rejection is no longer
   * possible, so it degrades to a BYE instead of throwing inside the caller's
   * error handler.
   */
  async reject(statusCode = 488): Promise<void> {
    try {
      if (this.invitation) {
        if (this.invitation.state === SessionState.Established || this.invitation.state === SessionState.Establishing) {
          await this.invitation.bye();
        } else {
          await this.invitation.reject({ statusCode });
        }
      } else if (this.inviter) {
        await this.inviter.cancel();
      }
    } catch {
      // the dialog is already gone; nothing further to signal
    }
  }

  async terminate(): Promise<void> {
    const session = this.invitation ?? this.inviter;
    if (session && session.state !== SessionState.Terminated) {
      await session.bye().catch(() => undefined);
    }
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.handler?.close();
  }
}

export interface SipEndpointHandlers {
  /** Must answer the call itself via `call.accept()` or `call.reject()`. */
  onIncoming?: (call: SipCall) => Promise<void>;
  onDtmf?: (call: SipCall, digit: string) => void;
  onMedia?: (call: SipCall, payload: Uint8Array) => void;
  onEnded?: (call: SipCall) => void;
}

/** SIP user agent for the gateway: answers inbound calls and can dial out. */
export class SipEndpoint {
  readonly userAgent: UserAgent;
  private readonly onError: (message: string) => void;
  private readonly options: SipEndpointOptions;
  private readonly handlers: SipEndpointHandlers;
  private readonly calls = new WeakMap<object, SipCall>();
  private started = false;

  constructor(
    options: SipEndpointOptions,
    handlers: SipEndpointHandlers = {},
    onError: (message: string) => void = () => {}
  ) {
    this.options = options;
    this.handlers = handlers;
    this.onError = onError;
    const uri = UserAgent.makeURI(options.uri);
    if (!uri) throw new Error(`无效的 SIP uri: ${options.uri}`);
    this.userAgent = new UserAgent({
      uri,
      displayName: options.displayName ?? 'OpenMeet',
      transportConstructor: UdpTransport,
      transportOptions: options as never,
      sessionDescriptionHandlerFactory: this.createHandlerFactory(),
      logLevel: 'error'
    });
  }

  /**
   * sip.js creates the media handler lazily, only once the session starts
   * establishing — which is after `onInvite` returns. It calls the factory with
   * the Session itself, so registering the call by session object binds events
   * deterministically without a global registry.
   */
  private createHandlerFactory(): (session: unknown, options: unknown) => GatewaySessionDescriptionHandler {
    const listenAddress = this.options.listenAddress;
    const handlers = this.handlers;
    const calls = this.calls;
    return (session: unknown) => {
      const call = calls.get(session as object);
      const sdh = new GatewaySessionDescriptionHandler(session, {
        listenAddress,
        events: {
          onRtp: (payload) => {
            if (call) handlers.onMedia?.(call, payload);
          },
          onDtmf: (digit) => {
            if (call) handlers.onDtmf?.(call, digit);
          }
        }
      });
      const originalClose = sdh.close.bind(sdh);
      sdh.close = () => {
        originalClose();
        if (call) handlers.onEnded?.(call);
      };
      call?.attach(sdh);
      return sdh;
    };
  }

  private logError(message: string): void {
    this.onError(message);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const delegate: UserAgentDelegate = {
      onInvite: (invitation: Invitation) => {
        const call = new SipCall(invitation, null);
        this.calls.set(invitation, call);
        void (async () => {
          try {
            // The handler answers the call itself: a bridge has to join the room
            // before it can describe the media it will accept.
            await (this.handlers.onIncoming?.(call) ?? call.reject(486).then(() => 'reject' as const));
          } catch (error) {
            this.logError(`处理入呼失败：${error instanceof Error ? error.message : String(error)}`);
            await call.reject(500);
          }
        })();
        return true;
      }
    };
    this.userAgent.delegate = delegate;
    await this.userAgent.start();
  }

  async dial(target: string): Promise<SipCall> {
    const uri = UserAgent.makeURI(target);
    if (!uri) throw new Error(`无效的拨出地址: ${target}`);
    const inviter = new Inviter(this.userAgent, uri);
    const call = new SipCall(null, inviter);
    this.calls.set(inviter, call);
    await inviter.invite();
    return call;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.userAgent.stop();
  }
}
