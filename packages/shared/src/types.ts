export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
}

export type UserRole = 'admin' | 'user';
export type Role = 'host' | 'cohost' | 'participant';
export type RoomKind = 'server' | 'lan';
export type RoomStatus = 'active' | 'ended';

export interface RoomView {
  id: string;
  code: string;
  title: string;
  kind: RoomKind;
  locked: boolean;
  lobby: boolean;
  maxParticipants: number;
  hostPeerId: string | null;
  createdAt: number;
  /** SIP/PSTN number that reaches this room, when the operator enabled dial-in. */
  dialIn?: string | null;
  status: 'active';
}

export interface MediaState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
  handRaised: boolean;
}

export interface Participant {
  peerId: string;
  userId: string | null;
  name: string;
  role: Role;
  guest: boolean;
  state: MediaState;
  joinedAt: number;
}

export interface PendingJoin {
  peerId: string;
  name: string;
  guest: boolean;
  requestedAt: number;
}

export interface ChatMessage {
  id: string;
  peerId: string;
  name: string;
  text: string;
  at: number;
  clientId?: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  iceTransportPolicy?: 'all' | 'relay';
}

export interface RoomSummary {
  id: string;
  code: string;
  title: string;
  role: 'host' | 'participant';
  status: RoomStatus;
  createdAt: number;
  endedAt: number | null;
  participantCount: number;
  maxParticipants: number;
}

export interface ServerInfo {
  name: string;
  version: string;
  protocol: number;
  mode: 'server' | 'lan';
  registration: 'open' | 'closed';
  guests: boolean;
  maxParticipants: number;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface GrantSelf {
  userId: string | null;
  displayName: string;
  guest: boolean;
  host: boolean;
}

export interface JoinResponse {
  ticket: string;
  room: RoomView;
  self: GrantSelf;
  ice: IceConfig;
  inviteToken?: string;
}

export type SignalData =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | {
      kind: 'candidate';
      candidate: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string | null;
      };
    };

export interface WelcomeSelf {
  peerId: string;
  userId: string | null;
  name: string;
  role: Role;
  guest: boolean;
  admitted: boolean;
}

export type ClientMessage =
  | { type: 'hello'; v: number; ticket: string }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'media'; state: MediaState }
  | { type: 'chat'; text: string; clientId?: string }
  | { type: 'lobby.admit'; peerId: string }
  | { type: 'lobby.deny'; peerId: string }
  | { type: 'room.lock'; locked: boolean }
  | { type: 'room.kick'; peerId: string }
  | { type: 'room.mute'; peerId: string }
  | { type: 'room.role'; peerId: string; role: 'cohost' | 'participant' }
  | { type: 'room.end' }
  | { type: 'room.leave' }
  | { type: 'ping'; t: number };

export type RoomEndReason = 'host_ended' | 'empty' | 'server_shutdown' | 'host_left';
export type PeerLeaveReason = 'left' | 'kicked' | 'disconnected';

export type ServerMessage =
  | {
      type: 'welcome';
      protocol: number;
      self: WelcomeSelf;
      room: RoomView;
      participants: Participant[];
      pending: PendingJoin[];
      admitted: boolean;
    }
  | { type: 'admitted'; room: RoomView; participants: Participant[] }
  | { type: 'lobby.request'; peer: PendingJoin }
  | { type: 'lobby.update'; pending: PendingJoin[] }
  | { type: 'lobby.denied'; reason?: string }
  | { type: 'peer.join'; peer: Participant }
  | { type: 'peer.leave'; peerId: string; reason: PeerLeaveReason }
  | { type: 'peer.update'; peerId: string; state: MediaState; role?: Role }
  | { type: 'room.update'; room: RoomView }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'chat'; message: ChatMessage }
  | {
      type: 'moderation';
      action: 'muted' | 'kicked' | 'role';
      byName?: string;
      role?: Role;
      reason?: string;
    }
  | { type: 'room.ended'; reason: RoomEndReason; byName?: string }
  | { type: 'pong'; t: number }
  | { type: 'error'; code: string; message: string; request?: string };

export interface InvitePayload {
  v: 1;
  kind: RoomKind;
  title: string;
  code: string;
  token: string;
  server?: string;
  rid?: string;
  endpoints?: string[];
}

export interface JoinTicketClaims {
  typ: 'join';
  sub: string;
  sid: string;
  name: string;
  roomId: string;
  code: string;
  guest: boolean;
  userId?: string;
  host: boolean;
  iat: number;
  exp: number;
  jti: string;
}

export interface AccessTokenClaims {
  typ: 'access';
  sub: string;
  name: string;
  role: UserRole;
  iat: number;
  exp: number;
  jti: string;
}
