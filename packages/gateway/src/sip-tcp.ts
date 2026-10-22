import { createConnection, createServer as createTcpServer, Server, type Socket } from 'node:net';
import { createServer as createTlsServer, connect as connectTls } from 'node:tls';
import { TransportState, EmitterImpl } from 'sip.js';
import { SipMessageStream, callIdOf, isResponse } from './sip-stream.js';
import { extractCallId, rememberCalledNumber, rewriteRequestLine } from './ruri.js';

export interface TcpTransportOptions {
  listenAddress: string;
  listenPort: number;
  /** Outbound next hop (PBX / SBC). Omitted means listen-only. */
  peer?: { address: string; port: number } | null;
  aorUser?: string;
  /** Present ⇒ TLS on both the listener and the outbound connection. */
  /** Key/cert for mutual TLS or for the listener's identity. Optional for a
   *  plain TLS client, which needs no certificate of its own. */
  tls?: { keyPem: string; certPem: string } | null;
  /** Transport family; 'tls' also works without `tls` when connecting out. */
  transport?: 'tcp' | 'tls';
  /** Reject peer certificates that do not verify. Off by default because
   *  most operator trunks still ship self-signed TLS. */
  rejectUnauthorized?: boolean;
}

interface TrackedSocket extends Socket {
  remote?: { address: string; port: number };
}

/**
 * TCP/TLS SIP transport. Two things make it more than "net.connect": messages
 * must be framed by Content-Length, and a response has to leave by the same
 * connection its request arrived on — a trunk that initiated the dialog is not
 * necessarily the configured next hop.
 */
export class TcpTransport {
  protocol: string;
  onConnect: (() => void) | undefined;
  onDisconnect: ((error?: Error) => void) | undefined;
  onMessage: ((message: string) => void) | undefined;
  readonly stateChange = new EmitterImpl<TransportState>();

  private readonly options: TcpTransportOptions;
  private server: Server | null = null;
  private outbound: TrackedSocket | null = null;
  private readonly byCallId = new Map<string, TrackedSocket>();
  private lastIncoming: TrackedSocket | null = null;
  private _state: TransportState = TransportState.Disconnected;
  private closed = false;
  /** Set while a socket's data handler runs, so receive() can attribute origin. */
  private currentSocket: TrackedSocket | null = null;

  constructor(_logger: unknown, options: TcpTransportOptions) {
    this.options = options;
    this.protocol = this.usesTls ? 'TLS' : 'TCP';
  }

  /** TLS is requested explicitly, or implied by presenting a certificate. */
  private get usesTls(): boolean {
    return this.options.transport === 'tls' || Boolean(this.options.tls);
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

  async connect(): Promise<void> {
    if (this.closed) throw new Error('transport disposed');
    await this.listen();
    if (this.options.peer) await this.dialPeer();
    this.setState(TransportState.Connected);
    this.onConnect?.();
  }

  private listen(): Promise<void> {
    const { listenAddress, listenPort, tls } = this.options;
    return new Promise((resolve, reject) => {
      const onConnection = (socket: Socket) => this.accept(socket as TrackedSocket);
      const server = tls
        ? createTlsServer({ key: tls.keyPem, cert: tls.certPem }, onConnection)
        : createTcpServer(onConnection);
      this.server = server as unknown as Server;
      server.once('error', reject);
      server.listen(listenPort, listenAddress, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  private dialPeer(): Promise<void> {
    const peer = this.options.peer;
    if (!peer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tlsOptions = this.usesTls
        ? {
            host: peer.address,
            port: peer.port,
            rejectUnauthorized: this.options.rejectUnauthorized ?? false,
            ...(this.options.tls ? { key: this.options.tls.keyPem, cert: this.options.tls.certPem } : {})
          }
        : undefined;
      const socket = (
        tlsOptions ? connectTls(tlsOptions) : createConnection({ host: peer.address, port: peer.port })
      ) as TrackedSocket;
      socket.remote = peer;
      this.outbound = socket;
      const onError = (error: Error) => {
        socket.removeListener('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        this.attach(socket);
        resolve();
      };
      socket.once('error', onError);
      // For TLS, 'connect' fires before the handshake finishes; attaching data
      // handlers then would read ciphertext, and attaching on both events would
      // parse every message twice. Wait for the event that means "ready".
      socket.once(this.options.tls ? 'secureConnect' : 'connect', onConnect);
    });
  }

  private accept(socket: TrackedSocket): void {
    const address = socket.remoteAddress;
    const port = socket.remotePort;
    if (address && port) socket.remote = { address, port };
    this.attach(socket);
    // A passive connection is enough to consider the transport usable.
    if (!this.isConnected()) {
      this.setState(TransportState.Connected);
      this.onConnect?.();
    }
  }

  private attach(socket: TrackedSocket): void {
    const stream = new SipMessageStream();
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.currentSocket = socket;
      try {
        for (const message of stream.push(chunk)) this.receive(message);
      } finally {
        this.currentSocket = null;
      }
    });
    socket.on('error', () => {
      /* surfaced through the next send failure or close */
    });
    socket.on('close', () => {
      if (this.outbound === socket) {
        this.outbound = null;
        if (!this.serverHasSockets()) {
          this.setState(TransportState.Disconnected);
          this.onDisconnect?.();
        }
      }
      for (const [callId, owner] of this.byCallId) {
        if (owner === socket) this.byCallId.delete(callId);
      }
      if (this.lastIncoming === socket) this.lastIncoming = null;
    });
  }

  private receive(raw: string): void {
    let message = raw;
    const socket = this.currentSocket;
    if (socket) {
      this.lastIncoming = socket;
      if (!isResponse(message)) {
        const callId = extractCallId(message);
        if (callId) this.byCallId.set(callId, socket);
      }
    }
    const aorUser = this.options.aorUser;
    if (aorUser) {
      const boundary = message.indexOf('\r\n');
      const firstLine = boundary < 0 ? message : message.slice(0, boundary);
      const rewritten = rewriteRequestLine(firstLine, aorUser);
      if (rewritten.called) rememberCalledNumber(extractCallId(message), rewritten.called);
      if (rewritten.line !== firstLine) message = rewritten.line + message.slice(boundary);
    }
    this.onMessage?.(message);
  }

  send(message: string): Promise<void> {
    const target = this.routeFor(message);
    if (!target || target.destroyed) return Promise.reject(new Error('没有可用的 TCP 连接'));
    return new Promise((resolve, reject) => {
      target.write(message, 'utf8', (error) => (error ? reject(error) : resolve()));
    });
  }

  /** Responses go back where the request came from; requests to the next hop. */
  private routeFor(message: string): TrackedSocket | null {
    if (isResponse(message)) {
      const callId = callIdOf(message);
      const known = callId ? this.byCallId.get(callId) : undefined;
      if (known) return known;
      if (this.lastIncoming) return this.lastIncoming;
    }
    return this.outbound ?? this.lastIncoming ?? null;
  }

  async disconnect(): Promise<void> {
    this.setState(TransportState.Disconnected);
    this.onDisconnect?.();
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.outbound?.destroy();
    this.server?.close();
    this.byCallId.clear();
  }

  private serverHasSockets(): boolean {
    return this.byCallId.size > 0 || (this.lastIncoming !== null && !this.lastIncoming.destroyed);
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    this.stateChange.emit(next);
  }
}
