import { randomInt, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  ApiError,
  ERROR_CODES,
  PROTOCOL_VERSION,
  WS_CLOSE,
  generateRoomCode,
  normalizeDialIn,
  normalizeRoomCode,
  parseClientMessage
} from '@openmeet/shared';
import type {
  ChatMessage,
  ClientMessage,
  JoinResponse,
  MediaState,
  Participant,
  PendingJoin,
  Role,
  RoomEndReason,
  RoomView,
  ServerMessage,
  SignalData,
  WelcomeSelf
} from '@openmeet/shared';
import type { EndedRoomRow, UserRecord } from './db.js';
import { AppDatabase } from './db.js';
import type { ServerConfig } from './config.js';
import { clampRoomMax, validateTurnConfig } from './config.js';
import { hashPassword, inviteTokenMatches, makeInviteToken, signToken, verifyJoinTicket, verifyPassword } from './auth.js';
import type { IceService } from './ice.js';
import type { Logger } from './log.js';

export interface RoomOptions {
  title: string;
  password?: string;
  lobby?: boolean;
  maxParticipants?: number;
  /** SIP/PSTN number that reaches this room; omitted means no dial-in. */
  dialIn?: string;
}

interface LiveRoom {
  view: RoomView;
  hostUserId: string;
  passwordHash: string | null;
  peers: Map<string, Peer>;
  admittedSids: Set<string>;
  bannedSids: Set<string>;
  emptyTimer: NodeJS.Timeout | null;
  hostTimer: NodeJS.Timeout | null;
  ended: boolean;
}

interface Peer {
  peerId: string;
  sid: string;
  userId: string | null;
  name: string;
  guest: boolean;
  role: Role;
  state: MediaState;
  admitted: boolean;
  joinedAt: number;
  lastSeen: number;
  socket: WebSocket;
  dbParticipantId: number | null;
  removed: boolean;
}

interface ConnectionState {
  peer: Peer | null;
  room: LiveRoom | null;
  helloDeadline: NodeJS.Timeout | null;
  rateWindowStart: number;
  rateCount: number;
  chatTimes: number[];
}

export interface RoomManagerDeps {
  db: AppDatabase;
  config: ServerConfig;
  ice: IceService;
  logger: Logger;
}

const EMPTY_MEDIA_STATE: MediaState = { mic: false, camera: false, screen: false, handRaised: false };

function cleanText(value: string, max: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeTitle(value: string): string {
  const title = cleanText(value, 80);
  if (!title) throw new ApiError(400, ERROR_CODES.invalidRequest, '房间标题不能为空');
  return title;
}

function normalizeDisplayName(value: string | undefined, fallback: string): string {
  const name = cleanText(value ?? '', 40);
  return name || fallback;
}

function api(status: number, code: keyof typeof ERROR_CODES, message: string): never {
  throw new ApiError(status, ERROR_CODES[code], message);
}

export class RoomManager {
  private readonly db: AppDatabase;
  private readonly config: ServerConfig;
  private readonly ice: IceService;
  private readonly logger: Logger;
  private readonly rooms = new Map<string, LiveRoom>();
  private readonly byCode = new Map<string, LiveRoom>();

  constructor(deps: RoomManagerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.ice = deps.ice;
    this.logger = deps.logger;
    validateTurnConfig(this.config.turn);
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }

  async createRoomForUser(user: UserRecord, options: RoomOptions): Promise<JoinResponse> {
    return this.createRoom(user.id, user.displayName, 'server', options);
  }

  async createLanRoom(hostName: string, options: RoomOptions): Promise<JoinResponse> {
    if (this.config.mode !== 'lan') {
      throw new ApiError(403, ERROR_CODES.lanMode, '房间创建接口仅在局域网模式可用');
    }
    const host = this.db.ensureLanHostUser();
    return this.createRoom(host.id, normalizeDisplayName(hostName, '局域网主机'), 'lan', options);
  }

  private async createRoom(hostUserId: string, hostName: string, kind: 'server' | 'lan', options: RoomOptions): Promise<JoinResponse> {
    const title = normalizeTitle(options.title);
    const lobby = Boolean(options.lobby);
    const maxParticipants = clampRoomMax(this.config.maxParticipants, options.maxParticipants);
    const password = options.password?.length ? options.password : null;
    if (password && (password.length < 4 || password.length > 64)) {
      api(400, 'invalidRequest', '房间密码长度必须为 4–64 个字符');
    }
    const passwordHash = password ? await hashPassword(password) : null;
    let dialIn: string | null = null;
    if (options.dialIn !== undefined && options.dialIn !== '') {
      dialIn = normalizeDialIn(options.dialIn);
      if (!dialIn) api(400, 'invalidRequest', '拨入号码只能包含数字、可选的 + 前缀与字母，长度 3–32');
      if (this.db.dialInExists(dialIn)) api(409, 'dialInTaken', '该拨入号码已被其它会议占用');
    }

    const id = `r_${randomUUID()}`;
    let code = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateRoomCode((max) => randomInt(max));
      if (!this.db.roomCodeExists(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) api(500, 'internalError', '无法分配房间号');

    const createdAt = Date.now();
    this.db.createRoom({
      id,
      code,
      title,
      hostUserId,
      passwordHash,
      lobby,
      maxParticipants,
      createdAt,
      dialIn
    });

    const room: LiveRoom = {
      view: {
        id,
        code,
        title,
        kind,
        locked: false,
        lobby,
        maxParticipants,
        hostPeerId: null,
        createdAt,
        dialIn,
        status: 'active'
      },
      hostUserId,
      passwordHash,
      peers: new Map(),
      admittedSids: new Set(),
      bannedSids: new Set(),
      emptyTimer: null,
      hostTimer: null,
      ended: false
    };
    this.rooms.set(id, room);
    this.byCode.set(code, room);
    this.scheduleEmptyRoom(room);
    this.logger.info(
      `Room ${room.view.code} created (${kind}, lobby=${lobby}, max=${maxParticipants}${dialIn ? `, dial-in=${dialIn}` : ''})`
    );

    const sid = randomUUID();
    const ticket = this.issueTicket(room, {
      sid,
      userId: hostUserId,
      name: hostName,
      guest: false,
      host: true
    });
    return {
      ticket,
      room: this.viewOf(room),
      self: { userId: hostUserId, displayName: hostName, guest: false, host: true },
      ice: this.ice.getIceConfig({ userId: hostUserId, sid }),
      inviteToken: this.inviteToken(room)
    };
  }

  /** Rebuild a live room exactly as its host created it, under the same code. */
  private reviveRoom(stored: EndedRoomRow): LiveRoom {
    const room: LiveRoom = {
      view: {
        id: stored.id,
        code: stored.code,
        title: stored.title,
        kind: 'server',
        locked: false,
        lobby: stored.lobby,
        maxParticipants: stored.maxParticipants,
        hostPeerId: null,
        createdAt: stored.createdAt,
        dialIn: stored.dialIn,
        status: 'active'
      },
      hostUserId: stored.hostUserId,
      passwordHash: stored.passwordHash,
      peers: new Map(),
      admittedSids: new Set(),
      bannedSids: new Set(),
      emptyTimer: null,
      hostTimer: null,
      ended: false
    };
    this.db.reactivateRoom(stored.id);
    this.rooms.set(stored.id, room);
    this.byCode.set(stored.code, room);
    this.scheduleEmptyRoom(room);
    this.logger.info(`Room ${stored.code} reopened by its host`);
    return room;
  }

  async joinRoom(input: {
    code: string;
    user: UserRecord | null;
    displayName?: string;
    password?: string;
    inviteToken?: string;
  }): Promise<JoinResponse> {
    const code = normalizeRoomCode(input.code);
    if (!code) api(404, 'roomNotFound', '会议不存在或房间号格式有误');
    let room = this.byCode.get(code);
    if (!room) {
      // Only the host who created an ended room may reopen it, keeping the same
      // code, title, password and capacity. Everyone else still faces 410.
      const stored = this.db.endedRoomByCode(code);
      if (stored && input.user && input.user.id === stored.hostUserId) {
        room = this.reviveRoom(stored);
      }
    }
    if (!room || room.ended) api(410, 'roomEnded', '会议已结束');
    const user = input.user;
    const isHostUser = Boolean(user && user.id === room.hostUserId);

    if (room.view.locked && !isHostUser) {
      api(403, 'roomLocked', '会议已锁定，暂不接受新成员');
    }

    if (room.passwordHash && !isHostUser) {
      if (!input.password) api(401, 'passwordRequired', '该会议需要密码');
      if (!(await verifyPassword(input.password, room.passwordHash))) {
        api(403, 'wrongPassword', '会议密码不正确');
      }
    }

    let name: string;
    let guest = false;
    if (user) {
      name = user.displayName;
    } else {
      if (room.view.kind === 'lan') api(403, 'inviteRequired', '局域网会议必须使用邀请加入');
      if (!this.config.allowGuests) api(403, 'guestsDisabled', '该服务器不允许访客加入');
      if (!input.inviteToken) api(403, 'inviteRequired', '需要邀请令牌才能加入');
      if (!inviteTokenMatches(this.inviteToken(room), input.inviteToken)) {
        api(403, 'invalidInvite', '邀请令牌无效或已失效');
      }
      name = normalizeDisplayName(input.displayName, '');
      if (!name) api(400, 'invalidRequest', '请输入显示名称');
      guest = true;
    }

    if (!isHostUser && room.peers.size >= room.view.maxParticipants) {
      api(409, 'roomFull', '会议人数已满');
    }

    const sid = randomUUID();
    const ticket = this.issueTicket(room, {
      sid,
      userId: user?.id ?? null,
      name,
      guest,
      host: isHostUser
    });

    return {
      ticket,
      room: this.viewOf(room),
      self: { userId: user?.id ?? null, displayName: name, guest, host: isHostUser },
      ice: this.ice.getIceConfig({ userId: user?.id ?? null, sid }),
      ...(isHostUser ? { inviteToken: this.inviteToken(room) } : {})
    };
  }

  async joinLan(input: {
    roomId: string;
    inviteToken: string;
    displayName?: string;
    password?: string;
  }): Promise<JoinResponse> {
    if (this.config.mode !== 'lan') api(403, 'lanMode', '该接口仅在局域网模式可用');
    const room = this.rooms.get(input.roomId);
    if (!room || room.ended || room.view.kind !== 'lan') api(404, 'roomNotFound', '会议不存在');
    if (room.view.locked) api(403, 'roomLocked', '会议已锁定');
    if (room.passwordHash) {
      if (!input.password) api(401, 'passwordRequired', '该会议需要密码');
      if (!(await verifyPassword(input.password, room.passwordHash))) {
        api(403, 'wrongPassword', '会议密码不正确');
      }
    }
    if (!input.inviteToken || !inviteTokenMatches(this.inviteToken(room), input.inviteToken)) {
      api(403, 'invalidInvite', '邀请令牌无效或已失效');
    }
    const name = normalizeDisplayName(input.displayName, '');
    if (!name) api(400, 'invalidRequest', '请输入显示名称');
    if (room.peers.size >= room.view.maxParticipants) api(409, 'roomFull', '会议人数已满');

    const sid = randomUUID();
    const ticket = this.issueTicket(room, { sid, userId: null, name, guest: true, host: false });
    return {
      ticket,
      room: this.viewOf(room),
      self: { userId: null, displayName: name, guest: true, host: false },
      ice: this.ice.getIceConfig({ userId: null, sid })
    };
  }

  /**
   * Turn a dialled number into a join ticket for the interop gateway.
   * The gateway is trusted infrastructure (shared bearer token), so it skips the
   * room password, but lock, capacity and lobby admission still apply.
   */
  resolveDialIn(number: string, displayName: string): JoinResponse {
    if (!this.config.gatewayToken) {
      api(403, 'gatewayUnauthorized', '服务器未配置 OPENMEET_GATEWAY_TOKEN，网关接口不可用');
    }
    const dialIn = normalizeDialIn(number);
    if (!dialIn) api(400, 'invalidRequest', '拨入号码格式不正确');
    const roomId = this.db.activeRoomIdByDialIn(dialIn);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room || room.ended) api(404, 'roomNotFound', '没有会议使用该拨入号码，或会议已结束');
    if (room.view.locked) api(403, 'roomLocked', '会议已锁定，不接受外部拨入');
    if (room.peers.size >= room.view.maxParticipants) api(409, 'roomFull', '会议人数已满');

    const name = normalizeDisplayName(displayName, '电话接入');
    const sid = randomUUID();
    const ticket = this.issueTicket(room, { sid, userId: null, name, guest: true, host: false });
    this.logger.info(`Dial-in ${dialIn} resolved to room ${room.view.code}`);
    return {
      ticket,
      room: this.viewOf(room),
      self: { userId: null, displayName: name, guest: true, host: false },
      ice: this.ice.getIceConfig({ userId: null, sid })
    };
  }

  private issueTicket(
    room: LiveRoom,
    input: { sid: string; userId: string | null; name: string; guest: boolean; host: boolean }
  ): string {
    return signToken(
      {
        typ: 'join',
        sub: input.userId ?? `guest_${input.sid}`,
        sid: input.sid,
        name: input.name,
        roomId: room.view.id,
        code: room.view.code,
        guest: input.guest,
        ...(input.userId ? { userId: input.userId } : {}),
        host: input.host
      },
      this.config.jwtSecret,
      this.config.joinTicketTtlSeconds
    );
  }

  private inviteToken(room: LiveRoom): string {
    return makeInviteToken(this.config.inviteSecret, room.view.id);
  }

  private viewOf(room: LiveRoom): RoomView {
    return { ...room.view };
  }

  private participantView(peer: Peer): Participant {
    return {
      peerId: peer.peerId,
      userId: peer.userId,
      name: peer.name,
      role: peer.role,
      guest: peer.guest,
      state: { ...peer.state },
      joinedAt: peer.joinedAt
    };
  }

  private pendingView(peer: Peer): PendingJoin {
    return { peerId: peer.peerId, name: peer.name, guest: peer.guest, requestedAt: peer.joinedAt };
  }

  private admittedPeers(room: LiveRoom): Peer[] {
    return [...room.peers.values()].filter((peer) => peer.admitted);
  }

  private pendingPeers(room: LiveRoom): Peer[] {
    return [...room.peers.values()].filter((peer) => !peer.admitted);
  }

  private canManage(peer: Peer): boolean {
    return peer.role === 'host' || peer.role === 'cohost';
  }

  handleConnection(socket: WebSocket): void {
    const state: ConnectionState = {
      peer: null,
      room: null,
      helloDeadline: null,
      rateWindowStart: Date.now(),
      rateCount: 0,
      chatTimes: []
    };

    state.helloDeadline = setTimeout(() => {
      if (!state.peer) {
        this.sendError(socket, 'protocol_error', 'Timed out waiting for hello');
        this.safeClose(socket, WS_CLOSE.protocol, 'hello timeout');
      }
    }, 10_000);

    socket.on('message', (raw, isBinary) => {
      try {
        if (isBinary) {
          this.sendError(socket, 'protocol_error', 'Binary frames are not supported');
          this.safeClose(socket, WS_CLOSE.badMessage, 'binary frame');
          return;
        }
        const now = Date.now();
        if (now - state.rateWindowStart > 10_000) {
          state.rateWindowStart = now;
          state.rateCount = 0;
        }
        state.rateCount += 1;
        if (state.rateCount > 60) {
          this.safeClose(socket, WS_CLOSE.rateLimited, 'message rate limit');
          return;
        }
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Buffer.from(raw).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          this.sendError(socket, 'protocol_error', 'Invalid JSON');
          this.safeClose(socket, WS_CLOSE.badMessage, 'invalid json');
          return;
        }
        const result = parseClientMessage(parsed);
        if (!result.ok) {
          this.sendError(socket, 'protocol_error', result.error);
          this.safeClose(socket, WS_CLOSE.badMessage, 'invalid message');
          return;
        }
        if (!state.peer) {
          if (result.value.type !== 'hello') {
            this.sendError(socket, 'protocol_error', 'First message must be hello');
            this.safeClose(socket, WS_CLOSE.badState, 'hello required');
            return;
          }
          this.handleHello(socket, state, result.value);
          return;
        }
        if (result.value.type === 'hello') {
          this.safeClose(socket, WS_CLOSE.badState, 'duplicate hello');
          return;
        }
        this.handleMessage(socket, state, result.value);
      } catch (error) {
        this.logger.error('Unhandled WS message error', error);
        this.sendError(socket, 'internal_error', 'Internal server error');
      }
    });

    socket.on('close', () => {
      if (state.helloDeadline) clearTimeout(state.helloDeadline);
      if (state.peer && state.room) this.handleDisconnect(state.peer, state.room);
    });

    socket.on('error', (error) => {
      this.logger.debug(`WebSocket error: ${error.message}`);
    });
  }

  private handleHello(socket: WebSocket, state: ConnectionState, message: Extract<ClientMessage, { type: 'hello' }>): void {
    if (message.v !== PROTOCOL_VERSION) {
      this.sendError(socket, 'protocol_error', `Unsupported protocol version ${message.v}`);
      this.safeClose(socket, WS_CLOSE.protocol, 'protocol version');
      return;
    }
    const claims = verifyJoinTicket(message.ticket, this.config.jwtSecret);
    if (!claims) {
      this.safeClose(socket, WS_CLOSE.auth, 'invalid ticket');
      return;
    }
    const room = this.rooms.get(claims.roomId);
    if (!room || room.ended) {
      this.safeClose(socket, WS_CLOSE.roomClosed, 'room closed');
      return;
    }
    if (room.view.code !== claims.code) {
      this.safeClose(socket, WS_CLOSE.auth, 'ticket room mismatch');
      return;
    }
    if (room.bannedSids.has(claims.sid)) {
      this.sendError(socket, 'forbidden', '你已被移出该会议');
      this.safeClose(socket, WS_CLOSE.removed, 'banned');
      return;
    }

    const previouslyAdmitted = room.admittedSids.has(claims.sid);
    let role: Role = 'participant';
    if (claims.host) {
      if (room.view.hostPeerId === null) {
        role = 'host';
        if (room.hostTimer) {
          clearTimeout(room.hostTimer);
          room.hostTimer = null;
        }
      } else {
        role = 'cohost';
      }
    }

    if (room.view.locked && !claims.host && !previouslyAdmitted) {
      this.sendError(socket, 'room_locked', '会议已锁定');
      this.safeClose(socket, WS_CLOSE.roomClosed, 'locked');
      return;
    }
    if (!claims.host && !previouslyAdmitted && room.peers.size >= room.view.maxParticipants) {
      this.sendError(socket, 'room_full', '会议人数已满');
      this.safeClose(socket, WS_CLOSE.roomClosed, 'room full');
      return;
    }

    const admitted = claims.host || previouslyAdmitted || !room.view.lobby;
    const peer: Peer = {
      peerId: `p_${randomUUID()}`,
      sid: claims.sid,
      userId: claims.userId ?? null,
      name: claims.name,
      guest: claims.guest,
      role: admitted ? role : 'participant',
      state: { ...EMPTY_MEDIA_STATE },
      admitted,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      socket,
      dbParticipantId: null,
      removed: false
    };
    if (admitted && role === 'host') {
      room.view.hostPeerId = peer.peerId;
    } else if (!admitted) {
      peer.role = 'participant';
    }

    room.peers.set(peer.peerId, peer);
    state.peer = peer;
    state.room = room;
    if (state.helloDeadline) {
      clearTimeout(state.helloDeadline);
      state.helloDeadline = null;
    }
    if (admitted && room.emptyTimer) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    }

    if (admitted) {
      room.admittedSids.add(peer.sid);
      try {
        peer.dbParticipantId = this.db.addParticipant({
          roomId: room.view.id,
          userId: peer.userId,
          guestName: peer.guest ? peer.name : null,
          role: peer.role,
          joinedAt: peer.joinedAt
        });
      } catch (error) {
        this.logger.error('Failed to persist participant', error);
      }
    }

    const self: WelcomeSelf = {
      peerId: peer.peerId,
      userId: peer.userId,
      name: peer.name,
      role: peer.role,
      guest: peer.guest,
      admitted
    };
    const welcome: ServerMessage = {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      self,
      room: this.viewOf(room),
      participants: admitted ? this.admittedPeers(room).filter((item) => item.peerId !== peer.peerId).map((item) => this.participantView(item)) : [],
      pending: admitted && this.canManage(peer) ? this.pendingPeers(room).map((item) => this.pendingView(item)) : [],
      admitted
    };
    this.send(socket, welcome);

    if (admitted) {
      this.broadcast(room, { type: 'peer.join', peer: this.participantView(peer) }, (item) => item.admitted && item.peerId !== peer.peerId);
      if (role === 'host') {
        this.broadcast(room, { type: 'room.update', room: this.viewOf(room) }, (item) => item.admitted);
      }
    } else {
      this.notifyLobbyRequest(room, peer);
      this.notifyLobbyUpdate(room);
    }
    this.logger.info(`Peer ${peer.name} ${admitted ? 'joined' : 'is waiting in'} room ${room.view.code}`);
  }

  private handleMessage(socket: WebSocket, state: ConnectionState, message: ClientMessage): void {
    const peer = state.peer;
    const room = state.room;
    if (!peer || !room) return;
    peer.lastSeen = Date.now();

    if (message.type === 'ping') {
      this.send(socket, { type: 'pong', t: message.t });
      return;
    }
    if (message.type === 'room.leave') {
      this.leaveRoom(room, peer, true);
      return;
    }
    if (!peer.admitted) {
      this.sendError(socket, 'not_admitted', '你还在等候室中');
      return;
    }

    try {
      switch (message.type) {
        case 'signal':
          this.handleSignal(room, peer, message.to, message.data);
          break;
        case 'media':
          peer.state = { ...message.state };
          this.broadcast(room, { type: 'peer.update', peerId: peer.peerId, state: { ...peer.state } }, (item) => item.admitted);
          break;
        case 'chat':
          this.handleChat(room, peer, message, state);
          break;
        case 'lobby.admit':
          this.requireManager(peer);
          this.admitPending(room, peer, message.peerId);
          break;
        case 'lobby.deny':
          this.requireManager(peer);
          this.denyPending(room, peer, message.peerId);
          break;
        case 'room.lock':
          this.requireManager(peer);
          room.view.locked = message.locked;
          try {
            this.db.setRoomLocked(room.view.id, message.locked);
          } catch (error) {
            this.logger.error('Failed to persist lock state', error);
          }
          this.broadcast(room, { type: 'room.update', room: this.viewOf(room) }, () => true);
          this.logger.info(`Room ${room.view.code} ${message.locked ? 'locked' : 'unlocked'} by ${peer.name}`);
          break;
        case 'room.kick':
          this.requireManager(peer);
          this.kickPeer(room, peer, message.peerId);
          break;
        case 'room.mute':
          this.requireManager(peer);
          this.mutePeer(room, peer, message.peerId);
          break;
        case 'room.role':
          this.requireHost(peer);
          this.changeRole(room, peer, message.peerId, message.role);
          break;
        case 'room.end':
          if (peer.role !== 'host' && !(peer.role === 'cohost' && room.view.hostPeerId === null)) {
            api(403, 'forbidden', '只有主持者可以结束会议');
          }
          this.endRoom(room, 'host_ended', peer.name);
          break;
        default:
          this.sendError(socket, 'protocol_error', 'Unsupported message');
      }
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendError(socket, error.code, error.message);
      } else {
        this.logger.error('Room action failed', error);
        this.sendError(socket, 'internal_error', 'Internal server error');
      }
    }
  }

  private handleSignal(room: LiveRoom, from: Peer, to: string, data: SignalData): void {
    if (to === from.peerId) api(400, 'invalidRequest', '不能向自己发送信令');
    const target = room.peers.get(to);
    if (!target || !target.admitted) api(404, 'unknownPeer', '目标成员不在会议中');
    this.send(target.socket, { type: 'signal', from: from.peerId, data });
  }

  private handleChat(room: LiveRoom, peer: Peer, message: Extract<ClientMessage, { type: 'chat' }>, state: ConnectionState): void {
    const now = Date.now();
    state.chatTimes = state.chatTimes.filter((stamp) => now - stamp < 5000);
    if (state.chatTimes.length >= 5) {
      this.sendError(peer.socket, 'rate_limited', '发送过于频繁，请稍后再试');
      return;
    }
    state.chatTimes.push(now);
    const chat: ChatMessage = {
      id: `m_${randomUUID()}`,
      peerId: peer.peerId,
      name: peer.name,
      text: message.text,
      at: now,
      ...(message.clientId ? { clientId: message.clientId } : {})
    };
    this.broadcast(room, { type: 'chat', message: chat }, (item) => item.admitted);
  }

  private requireManager(peer: Peer): void {
    if (!this.canManage(peer)) api(403, 'forbidden', '没有管理权限');
  }

  private requireHost(peer: Peer): void {
    if (peer.role !== 'host') api(403, 'forbidden', '只有主持者可以执行该操作');
  }

  private targetPeer(room: LiveRoom, peerId: string): Peer {
    const target = room.peers.get(peerId);
    if (!target) api(404, 'unknownPeer', '目标成员不存在');
    return target;
  }

  private assertModeratable(actor: Peer, target: Peer): void {
    if (target.peerId === actor.peerId) api(403, 'forbidden', '不能对自己执行该操作');
    if (target.role === 'host') api(403, 'forbidden', '不能操作主持者');
    if (actor.role === 'cohost' && target.role === 'cohost') {
      api(403, 'forbidden', '联席主持不能操作另一位联席主持');
    }
  }

  private admitPending(room: LiveRoom, actor: Peer, peerId: string): void {
    const target = this.targetPeer(room, peerId);
    if (target.admitted) api(409, 'invalidRequest', '该成员已经在会议中');
    target.admitted = true;
    room.admittedSids.add(target.sid);
    try {
      target.dbParticipantId = this.db.addParticipant({
        roomId: room.view.id,
        userId: target.userId,
        guestName: target.guest ? target.name : null,
        role: target.role,
        joinedAt: Date.now()
      });
    } catch (error) {
      this.logger.error('Failed to persist admitted participant', error);
    }
    this.send(target.socket, {
      type: 'admitted',
      room: this.viewOf(room),
      participants: this.admittedPeers(room)
        .filter((item) => item.peerId !== target.peerId)
        .map((item) => this.participantView(item))
    });
    this.broadcast(room, { type: 'peer.join', peer: this.participantView(target) }, (item) => item.admitted && item.peerId !== target.peerId);
    this.notifyLobbyUpdate(room);
    this.logger.info(`${actor.name} admitted ${target.name} to ${room.view.code}`);
  }

  private denyPending(room: LiveRoom, actor: Peer, peerId: string): void {
    const target = this.targetPeer(room, peerId);
    if (target.admitted) api(409, 'invalidRequest', '不能拒绝已准入成员');
    target.removed = true;
    room.peers.delete(target.peerId);
    room.bannedSids.add(target.sid);
    this.send(target.socket, { type: 'lobby.denied', reason: '主持者拒绝了你的加入请求' });
    this.safeClose(target.socket, WS_CLOSE.removed, 'denied');
    this.notifyLobbyUpdate(room);
    this.logger.info(`${actor.name} denied ${target.name} in ${room.view.code}`);
  }

  private kickPeer(room: LiveRoom, actor: Peer, peerId: string): void {
    const target = this.targetPeer(room, peerId);
    if (!target.admitted) api(409, 'invalidRequest', '只能移出会议中的成员');
    this.assertModeratable(actor, target);
    target.removed = true;
    room.peers.delete(target.peerId);
    room.bannedSids.add(target.sid);
    if (target.dbParticipantId !== null) {
      try {
        this.db.setParticipantLeft(target.dbParticipantId, Date.now());
      } catch (error) {
        this.logger.error('Failed to close participant record', error);
      }
    }
    this.send(target.socket, { type: 'moderation', action: 'kicked', byName: actor.name, reason: '被主持者移出会议' });
    this.broadcast(room, { type: 'peer.leave', peerId: target.peerId, reason: 'kicked' }, (item) => item.admitted);
    this.safeClose(target.socket, WS_CLOSE.removed, 'kicked');
    this.logger.info(`${actor.name} kicked ${target.name} from ${room.view.code}`);
  }

  private mutePeer(room: LiveRoom, actor: Peer, peerId: string): void {
    const target = this.targetPeer(room, peerId);
    if (!target.admitted) api(409, 'invalidRequest', '目标成员不在会议中');
    this.assertModeratable(actor, target);
    target.state = { ...target.state, mic: false };
    this.broadcast(room, { type: 'peer.update', peerId: target.peerId, state: { ...target.state } }, (item) => item.admitted);
    this.send(target.socket, { type: 'moderation', action: 'muted', byName: actor.name });
    this.logger.info(`${actor.name} muted ${target.name} in ${room.view.code}`);
  }

  private changeRole(room: LiveRoom, actor: Peer, peerId: string, role: 'cohost' | 'participant'): void {
    const target = this.targetPeer(room, peerId);
    if (!target.admitted) api(409, 'invalidRequest', '目标成员不在会议中');
    if (target.role === 'host') api(403, 'forbidden', '不能修改主持者角色');
    target.role = role;
    this.broadcast(room, { type: 'peer.update', peerId: target.peerId, state: { ...target.state }, role }, (item) => item.admitted);
    this.send(target.socket, { type: 'moderation', action: 'role', byName: actor.name, role });
    this.logger.info(`${actor.name} set ${target.name} to ${role} in ${room.view.code}`);
  }

  private leaveRoom(room: LiveRoom, peer: Peer, explicit: boolean): void {
    if (peer.removed) return;
    peer.removed = true;
    room.peers.delete(peer.peerId);
    if (peer.dbParticipantId !== null) {
      try {
        this.db.setParticipantLeft(peer.dbParticipantId, Date.now());
      } catch (error) {
        this.logger.error('Failed to close participant record', error);
      }
    }
    if (peer.admitted) {
      this.broadcast(room, { type: 'peer.leave', peerId: peer.peerId, reason: 'left' }, (item) => item.admitted);
    } else {
      this.notifyLobbyUpdate(room);
    }
    const wasHost = room.view.hostPeerId === peer.peerId;
    if (wasHost) {
      room.view.hostPeerId = null;
      if (room.hostTimer) {
        clearTimeout(room.hostTimer);
        room.hostTimer = null;
      }
      this.broadcast(room, { type: 'room.update', room: this.viewOf(room) }, (item) => item.admitted);
    }
    this.safeClose(peer.socket, WS_CLOSE.normal, 'left');
    this.logger.info(`Peer ${peer.name} left room ${room.view.code}`);

    if (wasHost) {
      if (this.admittedPeers(room).length === 0) {
        this.endRoom(room, explicit ? 'host_left' : 'empty', peer.name);
        return;
      }
      this.promoteHost(room);
      return;
    }
    if (this.admittedPeers(room).length === 0) this.scheduleEmptyRoom(room);
  }

  private handleDisconnect(peer: Peer, room: LiveRoom): void {
    if (peer.removed || room.ended) return;
    peer.removed = true;
    room.peers.delete(peer.peerId);
    if (peer.dbParticipantId !== null) {
      try {
        this.db.setParticipantLeft(peer.dbParticipantId, Date.now());
      } catch (error) {
        this.logger.error('Failed to close participant record', error);
      }
    }
    if (peer.admitted) {
      this.broadcast(room, { type: 'peer.leave', peerId: peer.peerId, reason: 'disconnected' }, (item) => item.admitted);
    } else {
      this.notifyLobbyUpdate(room);
    }
    const wasHost = room.view.hostPeerId === peer.peerId;
    if (wasHost) {
      room.view.hostPeerId = null;
      this.broadcast(room, { type: 'room.update', room: this.viewOf(room) }, (item) => item.admitted);
      if (room.hostTimer) clearTimeout(room.hostTimer);
      room.hostTimer = setTimeout(() => {
        room.hostTimer = null;
        if (room.ended || room.view.hostPeerId !== null) return;
        if (this.admittedPeers(room).length === 0) {
          this.endRoom(room, 'empty');
        } else {
          this.promoteHost(room);
        }
      }, this.config.hostGraceMs);
      room.hostTimer.unref?.();
    }
    if (this.admittedPeers(room).length === 0) this.scheduleEmptyRoom(room);
    this.logger.info(`Peer ${peer.name} disconnected from room ${room.view.code}`);
  }

  private promoteHost(room: LiveRoom): void {
    if (room.ended) return;
    if (room.view.hostPeerId !== null) return;
    const candidates = this.admittedPeers(room).sort((a, b) => {
      if (a.role === 'cohost' && b.role !== 'cohost') return -1;
      if (b.role === 'cohost' && a.role !== 'cohost') return 1;
      return a.joinedAt - b.joinedAt;
    });
    const next = candidates[0];
    if (!next) {
      this.endRoom(room, 'empty');
      return;
    }
    next.role = 'host';
    room.view.hostPeerId = next.peerId;
    if (room.hostTimer) {
      clearTimeout(room.hostTimer);
      room.hostTimer = null;
    }
    this.broadcast(room, { type: 'peer.update', peerId: next.peerId, state: { ...next.state }, role: 'host' }, (item) => item.admitted);
    this.broadcast(room, { type: 'room.update', room: this.viewOf(room) }, (item) => item.admitted);
    this.send(next.socket, {
      type: 'moderation',
      action: 'role',
      role: 'host',
      reason: '主持者已离开，你已被提升为主持者'
    });
    this.logger.info(`Host transferred to ${next.name} in room ${room.view.code}`);
  }

  private notifyLobbyRequest(room: LiveRoom, peer: Peer): void {
    const pending = this.pendingView(peer);
    this.broadcast(room, { type: 'lobby.request', peer: pending }, (item) => item.admitted && this.canManage(item));
  }

  private notifyLobbyUpdate(room: LiveRoom): void {
    const pending = this.pendingPeers(room).map((peer) => this.pendingView(peer));
    this.broadcast(room, { type: 'lobby.update', pending }, (item) => item.admitted && this.canManage(item));
  }

  private scheduleEmptyRoom(room: LiveRoom): void {
    if (room.ended) return;
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    room.emptyTimer = setTimeout(() => {
      room.emptyTimer = null;
      if (room.ended) return;
      if (this.admittedPeers(room).length === 0) this.endRoom(room, 'empty');
    }, this.config.roomEmptyTtlMs);
    room.emptyTimer.unref?.();
  }

  private endRoom(room: LiveRoom, reason: RoomEndReason, byName?: string): void {
    if (room.ended) return;
    room.ended = true;
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.emptyTimer = null;
    room.hostTimer = null;
    this.rooms.delete(room.view.id);
    this.byCode.delete(room.view.code);
    try {
      this.db.markRoomEnded(room.view.id, Date.now(), reason);
    } catch (error) {
      this.logger.error('Failed to mark room ended', error);
    }
    const now = Date.now();
    for (const peer of room.peers.values()) {
      if (peer.admitted && peer.dbParticipantId !== null) {
        try {
          this.db.setParticipantLeft(peer.dbParticipantId, now);
        } catch {
          // ignore
        }
      }
    }
    const message: ServerMessage = { type: 'room.ended', reason, ...(byName ? { byName } : {}) };
    const payload = JSON.stringify(message);
    const closeCode = reason === 'server_shutdown' ? WS_CLOSE.serverShutdown : WS_CLOSE.roomClosed;
    for (const peer of room.peers.values()) {
      peer.removed = true;
      try {
        if (peer.socket.readyState === WebSocket.OPEN) {
          peer.socket.send(payload);
          peer.socket.close(closeCode, `room ${reason}`);
        }
      } catch {
        // ignore
      }
    }
    room.peers.clear();
    this.logger.info(`Room ${room.view.code} ended (${reason})${byName ? ` by ${byName}` : ''}`);
  }

  endAll(reason: RoomEndReason = 'server_shutdown'): void {
    for (const room of [...this.rooms.values()]) this.endRoom(room, reason);
  }

  private broadcast(room: LiveRoom, message: ServerMessage, predicate: (peer: Peer) => boolean): void {
    const payload = JSON.stringify(message);
    for (const peer of room.peers.values()) {
      if (!predicate(peer)) continue;
      try {
        if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(payload);
      } catch (error) {
        this.logger.debug(`Failed to send WS message: ${String(error)}`);
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    } catch {
      // ignore
    }
  }

  private sendError(socket: WebSocket, code: string, message: string, request?: string): void {
    this.send(socket, { type: 'error', code, message, ...(request ? { request } : {}) });
  }

  private safeClose(socket: WebSocket, code: number, reason: string): void {
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason.slice(0, 120));
      }
    } catch {
      // ignore
    }
  }
}
