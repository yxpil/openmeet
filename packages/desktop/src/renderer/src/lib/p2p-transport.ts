import type {
  ChatMessage,
  ClientMessage,
  Participant,
  RoomView,
  ServerMessage,
  SignalData
} from '@openmeet/shared';
import type { MeetingTransport, MeetingTransportHandlers } from './meeting-client';
import type { P2pEvent, P2pStartResult } from '../../../shared/ipc';
import { EMPTY_P2P_STATE, type P2pPeerInfo } from '../../../shared/p2p';

export interface LanP2pTransportOptions {
  code: string;
  passphrase: string;
  displayName: string;
  /** Shown in the meeting header; the room itself has no server record. */
  title: string;
}

function participantOf(peer: P2pPeerInfo, joinedAt: number): Participant {
  return {
    peerId: peer.peerId,
    userId: null,
    name: peer.name,
    // Nobody owns a serverless meeting, so nobody holds server-granted powers.
    role: 'participant',
    guest: true,
    state: peer.state,
    joinedAt
  };
}

/**
 * Speaks the meeting client's server protocol on top of the serverless LAN mesh
 * that lives in the main process. The renderer sees one `welcome` followed by
 * roster diffs, exactly as it does with a server, so the WebRTC machinery is
 * shared rather than reimplemented.
 */
export class LanP2pTransport implements MeetingTransport {
  private handlers: MeetingTransportHandlers | null = null;
  private unsubscribe: (() => void) | null = null;
  private session: P2pStartResult | null = null;
  private readonly room: RoomView;
  private readonly peers = new Map<string, Participant>();
  private closed = false;

  constructor(private readonly options: LanP2pTransportOptions) {
    this.room = {
      id: 'lan-p2p',
      code: options.code,
      title: options.title,
      kind: 'lan',
      locked: false,
      lobby: false,
      maxParticipants: 12,
      hostPeerId: null,
      createdAt: Date.now(),
      status: 'active'
    };
  }

  bind(handlers: MeetingTransportHandlers): void {
    this.handlers = handlers;
  }

  /** The synthesized room record, shared with the meeting store for history rows. */
  get roomView(): RoomView {
    return this.room;
  }

  async start(): Promise<void> {
    const session = await window.openmeet.p2pStart({
      code: this.options.code,
      passphrase: this.options.passphrase,
      displayName: this.options.displayName
    });
    this.session = session;
    this.room.id = session.roomId;
    this.room.code = session.code;
    this.unsubscribe = window.openmeet.onP2pEvent((event) => this.onEvent(event));
    this.emitWelcome();
  }

  send(message: ClientMessage): boolean {
    if (this.closed || !this.session) return false;
    switch (message.type) {
      case 'signal':
        void window.openmeet.p2pSignal(message.to, message.data);
        return true;
      case 'media':
        void window.openmeet.p2pState(message.state);
        return true;
      case 'chat': {
        const at = Date.now();
        const id = crypto.randomUUID();
        void window.openmeet.p2pChat(message.text, id, at);
        // The mesh relays to others; the sender's own copy is echoed here, the
        // same way a server would bounce it back.
        this.deliver({
          type: 'chat',
          message: {
            id,
            peerId: this.session.peerId,
            name: this.options.displayName,
            text: message.text,
            at,
            ...(message.clientId ? { clientId: message.clientId } : {})
          }
        });
        return true;
      }
      case 'room.mute':
        void window.openmeet.p2pMute(message.peerId);
        return true;
      default:
        // hello/ping are meaningless without a server, and the moderation and
        // lobby verbs are not available in a serverless meeting.
        return true;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    void window.openmeet.p2pStop().catch(() => undefined);
  }

  private onEvent(event: P2pEvent): void {
    if (this.closed || !this.handlers) return;
    switch (event.kind) {
      case 'peers':
        this.diffRoster(event.peers);
        return;
      case 'signal': {
        // Unlike the server, the mesh gives no ordering guarantee: an offer can
        // land before the roster entry that would have created its PeerConnection.
        // Dropping it would stall the negotiation forever, because the polite
        // side waits for a remote description by design.
        if (!this.peers.has(event.from)) {
          const provisional = participantOf(
            { peerId: event.from, name: '新成员', host: '', port: 0, state: { ...EMPTY_P2P_STATE } },
            Date.now()
          );
          this.peers.set(event.from, provisional);
          this.deliver({ type: 'peer.join', peer: provisional });
        }
        this.deliver({ type: 'signal', from: event.from, data: event.data as SignalData });
        return;
      }
      case 'chat': {
        const message: ChatMessage = {
          id: event.id,
          peerId: event.from,
          name: event.name,
          text: event.text,
          at: event.at
        };
        this.deliver({ type: 'chat', message });
        return;
      }
      case 'left':
        if (this.peers.delete(event.peerId)) {
          this.deliver({ type: 'peer.leave', peerId: event.peerId, reason: 'disconnected' });
        }
        return;
      case 'fatal':
        this.handlers.onClose(event.message);
        return;
    }
  }

  private diffRoster(incoming: P2pPeerInfo[]): void {
    const seen = new Set<string>();
    for (const peer of incoming) {
      seen.add(peer.peerId);
      const known = this.peers.get(peer.peerId);
      if (!known) {
        const participant = participantOf(peer, Date.now());
        this.peers.set(peer.peerId, participant);
        this.deliver({ type: 'peer.join', peer: participant });
        continue;
      }
      if (known.name !== peer.name) {
        // Replaces a provisional name; ensurePeers() no-ops for a known peer, so
        // this corrects the roster without touching the live connection.
        const updated = participantOf(peer, known.joinedAt);
        this.peers.set(peer.peerId, updated);
        this.deliver({ type: 'peer.join', peer: updated });
        continue;
      }
      if (JSON.stringify(known.state) !== JSON.stringify(peer.state)) {
        known.state = peer.state;
        known.name = peer.name || known.name;
        this.deliver({ type: 'peer.update', peerId: known.peerId, state: known.state });
      }
    }
    for (const peerId of [...this.peers.keys()]) {
      if (seen.has(peerId)) continue;
      this.peers.delete(peerId);
      this.deliver({ type: 'peer.leave', peerId, reason: 'disconnected' });
    }
  }

  private emitWelcome(): void {
    if (!this.session) return;
    this.deliver({
      type: 'welcome',
      protocol: 1,
      self: {
        peerId: this.session.peerId,
        userId: null,
        name: this.options.displayName,
        role: 'participant',
        guest: true,
        admitted: true
      },
      room: this.room,
      participants: [...this.peers.values()],
      pending: [],
      admitted: true
    });
  }

  private deliver(message: ServerMessage): void {
    this.handlers?.onMessage(message);
  }
}
