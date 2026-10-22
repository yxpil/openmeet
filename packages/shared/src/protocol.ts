import {
  MAX_CANDIDATE_LENGTH,
  MAX_CHAT_TEXT_LENGTH,
  MAX_SDP_LENGTH
} from './constants.js';
import type {
  ChatMessage,
  ClientMessage,
  MediaState,
  Participant,
  PendingJoin,
  Role,
  RoomView,
  ServerMessage,
  SignalData
} from './types.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown, max = 64): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isRole(value: unknown): value is Role {
  return value === 'host' || value === 'cohost' || value === 'participant';
}

function isMediaState(value: unknown): value is MediaState {
  if (!isRecord(value)) return false;
  return (
    typeof value.mic === 'boolean' &&
    typeof value.camera === 'boolean' &&
    typeof value.screen === 'boolean' &&
    typeof value.handRaised === 'boolean'
  );
}

function isCandidateInit(value: unknown): value is NonNullable<Extract<SignalData, { kind: 'candidate' }>['candidate']> {
  if (!isRecord(value)) return false;
  if (typeof value.candidate !== 'string' || value.candidate.length > MAX_CANDIDATE_LENGTH) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && !isBoundedString(value.sdpMid, 0, 64)) return false;
  if (
    value.sdpMLineIndex !== undefined &&
    value.sdpMLineIndex !== null &&
    (typeof value.sdpMLineIndex !== 'number' || !Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 64)
  ) {
    return false;
  }
  if (
    value.usernameFragment !== undefined &&
    value.usernameFragment !== null &&
    !isBoundedString(value.usernameFragment, 0, 128)
  ) {
    return false;
  }
  return true;
}

export function parseSignalData(value: unknown): SignalData | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'offer' || value.kind === 'answer') {
    if (!isBoundedString(value.sdp, 1, MAX_SDP_LENGTH)) return null;
    return { kind: value.kind, sdp: value.sdp };
  }
  if (value.kind === 'candidate') {
    if (!isCandidateInit(value.candidate)) return null;
    return { kind: 'candidate', candidate: value.candidate };
  }
  return null;
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return { ok: false, error: 'Message must be an object with a type' };
  }
  switch (raw.type) {
    case 'hello':
      if (typeof raw.v !== 'number' || !Number.isInteger(raw.v)) {
        return { ok: false, error: 'hello.v must be an integer' };
      }
      if (!isBoundedString(raw.ticket, 1, 4096)) {
        return { ok: false, error: 'hello.ticket is invalid' };
      }
      return { ok: true, value: { type: 'hello', v: raw.v, ticket: raw.ticket } };
    case 'signal': {
      if (!isId(raw.to)) return { ok: false, error: 'signal.to is invalid' };
      const data = parseSignalData(raw.data);
      if (!data) return { ok: false, error: 'signal.data is invalid' };
      return { ok: true, value: { type: 'signal', to: raw.to, data } };
    }
    case 'media':
      if (!isMediaState(raw.state)) return { ok: false, error: 'media.state is invalid' };
      return { ok: true, value: { type: 'media', state: raw.state } };
    case 'chat': {
      if (typeof raw.text !== 'string') return { ok: false, error: 'chat.text is invalid' };
      const text = raw.text.trim();
      if (text.length === 0 || text.length > MAX_CHAT_TEXT_LENGTH) {
        return { ok: false, error: 'chat.text length is invalid' };
      }
      if (raw.clientId !== undefined && !isId(raw.clientId)) {
        return { ok: false, error: 'chat.clientId is invalid' };
      }
      const message: ClientMessage = { type: 'chat', text };
      if (typeof raw.clientId === 'string') message.clientId = raw.clientId;
      return { ok: true, value: message };
    }
    case 'lobby.admit':
    case 'lobby.deny':
    case 'room.kick':
    case 'room.mute': {
      if (!isId(raw.peerId)) return { ok: false, error: `${raw.type}.peerId is invalid` };
      return { ok: true, value: { type: raw.type, peerId: raw.peerId } };
    }
    case 'room.lock':
      if (typeof raw.locked !== 'boolean') return { ok: false, error: 'room.lock.locked is invalid' };
      return { ok: true, value: { type: 'room.lock', locked: raw.locked } };
    case 'room.role':
      if (!isId(raw.peerId)) return { ok: false, error: 'room.role.peerId is invalid' };
      if (raw.role !== 'cohost' && raw.role !== 'participant') {
        return { ok: false, error: 'room.role.role is invalid' };
      }
      return { ok: true, value: { type: 'room.role', peerId: raw.peerId, role: raw.role } };
    case 'room.end':
      return { ok: true, value: { type: 'room.end' } };
    case 'room.leave':
      return { ok: true, value: { type: 'room.leave' } };
    case 'ping':
      if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) {
        return { ok: false, error: 'ping.t is invalid' };
      }
      return { ok: true, value: { type: 'ping', t: raw.t } };
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

function isRoomView(value: unknown): value is RoomView {
  if (!isRecord(value)) return false;
  return (
    isId(value.id) &&
    typeof value.code === 'string' &&
    isBoundedString(value.title, 1, 80) &&
    (value.kind === 'server' || value.kind === 'lan') &&
    typeof value.locked === 'boolean' &&
    typeof value.lobby === 'boolean' &&
    typeof value.maxParticipants === 'number' &&
    Number.isInteger(value.maxParticipants) &&
    (value.hostPeerId === null || isId(value.hostPeerId)) &&
    typeof value.createdAt === 'number' &&
    value.status === 'active'
  );
}

function isParticipant(value: unknown): value is Participant {
  if (!isRecord(value)) return false;
  return (
    isId(value.peerId) &&
    (value.userId === null || isId(value.userId)) &&
    isBoundedString(value.name, 1, 40) &&
    isRole(value.role) &&
    typeof value.guest === 'boolean' &&
    isMediaState(value.state) &&
    typeof value.joinedAt === 'number'
  );
}

function isPendingJoin(value: unknown): value is PendingJoin {
  if (!isRecord(value)) return false;
  return (
    isId(value.peerId) &&
    isBoundedString(value.name, 1, 40) &&
    typeof value.guest === 'boolean' &&
    typeof value.requestedAt === 'number'
  );
}

function parseParticipantList(value: unknown, max = 64): Participant[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every(isParticipant)) return null;
  return value;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return (
    isId(value.id) &&
    isId(value.peerId) &&
    isBoundedString(value.name, 1, 40) &&
    isBoundedString(value.text, 1, MAX_CHAT_TEXT_LENGTH) &&
    typeof value.at === 'number' &&
    (value.clientId === undefined || isId(value.clientId))
  );
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  try {
    switch (raw.type) {
      case 'welcome': {
        if (!isRecord(raw.self) || !isRoomView(raw.room)) return null;
        const self = raw.self;
        if (
          !isId(self.peerId) ||
          (self.userId !== null && !isId(self.userId)) ||
          !isBoundedString(self.name, 1, 40) ||
          !isRole(self.role) ||
          typeof self.guest !== 'boolean' ||
          typeof self.admitted !== 'boolean'
        ) {
          return null;
        }
        const participants = parseParticipantList(raw.participants);
        if (!participants) return null;
        if (!Array.isArray(raw.pending) || raw.pending.length > 64 || !raw.pending.every(isPendingJoin)) return null;
        if (typeof raw.protocol !== 'number' || typeof raw.admitted !== 'boolean') return null;
        return {
          type: 'welcome',
          protocol: raw.protocol,
          self: {
            peerId: self.peerId,
            userId: self.userId,
            name: self.name,
            role: self.role,
            guest: self.guest,
            admitted: self.admitted
          },
          room: raw.room,
          participants,
          pending: raw.pending,
          admitted: raw.admitted
        };
      }
      case 'admitted': {
        if (!isRoomView(raw.room)) return null;
        const participants = parseParticipantList(raw.participants);
        return participants ? { type: 'admitted', room: raw.room, participants } : null;
      }
      case 'lobby.request':
        return isPendingJoin(raw.peer) ? { type: 'lobby.request', peer: raw.peer } : null;
      case 'lobby.update': {
        if (!Array.isArray(raw.pending) || raw.pending.length > 64 || !raw.pending.every(isPendingJoin)) return null;
        return { type: 'lobby.update', pending: raw.pending };
      }
      case 'lobby.denied':
        return { type: 'lobby.denied', reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : undefined };
      case 'peer.join':
        return isParticipant(raw.peer) ? { type: 'peer.join', peer: raw.peer } : null;
      case 'peer.leave': {
        if (!isId(raw.peerId)) return null;
        if (raw.reason !== 'left' && raw.reason !== 'kicked' && raw.reason !== 'disconnected') return null;
        return { type: 'peer.leave', peerId: raw.peerId, reason: raw.reason };
      }
      case 'peer.update': {
        if (!isId(raw.peerId) || !isMediaState(raw.state)) return null;
        if (raw.role !== undefined && !isRole(raw.role)) return null;
        const message: ServerMessage = { type: 'peer.update', peerId: raw.peerId, state: raw.state };
        if (isRole(raw.role)) message.role = raw.role;
        return message;
      }
      case 'room.update':
        return isRoomView(raw.room) ? { type: 'room.update', room: raw.room } : null;
      case 'signal': {
        if (!isId(raw.from)) return null;
        const data = parseSignalData(raw.data);
        return data ? { type: 'signal', from: raw.from, data } : null;
      }
      case 'chat':
        return isChatMessage(raw.message) ? { type: 'chat', message: raw.message } : null;
      case 'moderation': {
        if (raw.action !== 'muted' && raw.action !== 'kicked' && raw.action !== 'role') return null;
        const message: ServerMessage = { type: 'moderation', action: raw.action };
        if (typeof raw.byName === 'string') message.byName = raw.byName.slice(0, 40);
        if (isRole(raw.role)) message.role = raw.role;
        if (typeof raw.reason === 'string') message.reason = raw.reason.slice(0, 200);
        return message;
      }
      case 'room.ended': {
        if (
          raw.reason !== 'host_ended' &&
          raw.reason !== 'empty' &&
          raw.reason !== 'server_shutdown' &&
          raw.reason !== 'host_left'
        ) {
          return null;
        }
        const message: ServerMessage = { type: 'room.ended', reason: raw.reason };
        if (typeof raw.byName === 'string') message.byName = raw.byName.slice(0, 40);
        return message;
      }
      case 'pong':
        return typeof raw.t === 'number' ? { type: 'pong', t: raw.t } : null;
      case 'error':
        return isBoundedString(raw.code, 1, 64) && isBoundedString(raw.message, 1, 500)
          ? {
              type: 'error',
              code: raw.code,
              message: raw.message,
              request: typeof raw.request === 'string' ? raw.request.slice(0, 64) : undefined
            }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
