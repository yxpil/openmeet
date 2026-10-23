import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type {
  AuthResponse,
  InvitePayload,
  JoinResponse,
  ServerMessage,
  ServerInfo
} from '@openmeet/shared';
import { decodeInvite, encodeInvite, normalizeLanEndpoint } from '@openmeet/shared';
import { startServer } from '../src/index.js';
import type { RunningServer } from '../src/index.js';
import { silentLogger } from '../src/log.js';

type MessageType = ServerMessage['type'];
type MessageOf<T extends MessageType> = Extract<ServerMessage, { type: T }>;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

function codeOf(result: ApiResult): string | undefined {
  const error = result.body.error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function api(
  port: number,
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}
  };
}

interface Waiter {
  type: MessageType;
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class WsClient {
  private readonly socket: WebSocket;
  private readonly queue: ServerMessage[] = [];
  private waiters: Waiter[] = [];
  closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.queue.push(message);
      this.flush();
    });
    socket.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`socket closed while waiting for ${waiter.type}`));
      }
    });
    socket.on('error', (error) => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  static async connect(port: number): Promise<WsClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new WsClient(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  next<T extends MessageType>(
    type: T,
    predicate: (message: MessageOf<T>) => boolean = () => true,
    timeoutMs = 5000
  ): Promise<MessageOf<T>> {
    const existingIndex = this.queue.findIndex(
      (message) => message.type === type && predicate(message as MessageOf<T>)
    );
    if (existingIndex >= 0) {
      const [message] = this.queue.splice(existingIndex, 1);
      return Promise.resolve(message as MessageOf<T>);
    }
    return new Promise<MessageOf<T>>((resolve, reject) => {
      const waiter: Waiter = {
        type,
        predicate: (message) => message.type === type && predicate(message as MessageOf<T>),
        resolve: (message) => resolve(message as MessageOf<T>),
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error(`timed out waiting for ${type}; queued: ${this.queue.map((m) => m.type).join(',')}`));
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  private flush(): void {
    for (const waiter of [...this.waiters]) {
      const index = this.queue.findIndex((message) => waiter.predicate(message));
      if (index < 0) continue;
      const [message] = this.queue.splice(index, 1);
      this.waiters = this.waiters.filter((item) => item !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  close(): void {
    if (!this.closed) this.socket.close();
  }
}

async function register(port: number, username: string, password = 'correct-horse-1'): Promise<AuthResponse> {
  const result = await api(port, '/api/auth/register', {
    method: 'POST',
    body: { username, password, displayName: username }
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body as unknown as AuthResponse;
}

async function welcome(client: WsClient, port: number, ticket: string): Promise<MessageOf<'welcome'>> {
  client.send({ type: 'hello', v: 1, ticket });
  return client.next('welcome');
}

describe('OpenMeet server', () => {
  let running: RunningServer;
  let port: number;
  let dataDir: string;
  let alice: AuthResponse;
  let bob: AuthResponse;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'openmeet-test-'));
    running = await startServer({
      mode: 'server',
      host: '127.0.0.1',
      port: 0,
      dataDir,
      dbPath: join(dataDir, 'test.db'),
      jwtSecret: 'test-secret-'.repeat(6),
      gatewayToken: 'gateway-test-token',
      registration: 'open',
      allowGuests: true,
      stunUrls: [],
      turn: { mode: 'off' },
      logger: silentLogger
    });
    port = running.port;
    alice = await register(port, 'alice');
    bob = await register(port, 'bob');
  });

  after(async () => {
    await running.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports health and server capabilities', async () => {
    const health = await api(port, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const info = await api(port, '/api/server');
    assert.equal(info.status, 200);
    const server = info.body as unknown as ServerInfo;
    assert.equal(server.mode, 'server');
    assert.equal(server.protocol, 1);
    assert.equal(server.registration, 'open');
  });

  it('registers the first account as admin and enforces unique usernames', async () => {
    assert.equal(alice.user.role, 'admin');
    assert.equal(bob.user.role, 'user');
    const duplicate = await api(port, '/api/auth/register', {
      method: 'POST',
      body: { username: 'ALICE', password: 'another-pass-1' }
    });
    assert.equal(duplicate.status, 409);
    assert.equal(codeOf(duplicate), 'username_taken');
  });

  it('authenticates with access and rotating refresh tokens', async () => {
    const wrong = await api(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'not-the-password' }
    });
    assert.equal(wrong.status, 401);
    assert.equal(codeOf(wrong), 'invalid_credentials');

    const me = await api(port, '/api/auth/me', { token: alice.accessToken });
    assert.equal(me.status, 200);
    assert.equal((me.body.user as { username: string }).username, 'alice');

    const login = await api(port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'correct-horse-1' }
    });
    assert.equal(login.status, 200);
    const tokens = login.body as unknown as AuthResponse;

    const rotated = await api(port, '/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: tokens.refreshToken }
    });
    assert.equal(rotated.status, 200);
    const next = rotated.body as unknown as AuthResponse;
    assert.notEqual(next.refreshToken, tokens.refreshToken);

    const reuse = await api(port, '/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: tokens.refreshToken }
    });
    assert.equal(reuse.status, 401);
    assert.equal(codeOf(reuse), 'invalid_token');

    const afterReuse = await api(port, '/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: next.refreshToken }
    });
    assert.equal(afterReuse.status, 401);
  });

  it('protects rooms with passwords and lobby admission', async () => {
    const created = await api(port, '/api/rooms', {
      method: 'POST',
      token: alice.accessToken,
      body: { title: '设计评审', password: 'room-pass', lobby: true }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const room = created.body as unknown as JoinResponse;
    assert.ok(room.ticket);
    assert.ok(room.inviteToken);
    assert.equal(room.room.lobby, true);
    assert.equal(room.self.host, true);

    const noPassword = await api(port, `/api/rooms/${room.room.code}/join`, {
      method: 'POST',
      token: bob.accessToken,
      body: {}
    });
    assert.equal(noPassword.status, 401);
    assert.equal(codeOf(noPassword), 'password_required');

    const wrongPassword = await api(port, `/api/rooms/${room.room.code}/join`, {
      method: 'POST',
      token: bob.accessToken,
      body: { password: 'wrong-password' }
    });
    assert.equal(wrongPassword.status, 403);
    assert.equal(codeOf(wrongPassword), 'wrong_password');

    const joined = await api(port, `/api/rooms/${room.room.code}/join`, {
      method: 'POST',
      token: bob.accessToken,
      body: { password: 'room-pass' }
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const guestJoin = joined.body as unknown as JoinResponse;
    assert.equal(guestJoin.self.host, false);

    const hostClient = await WsClient.connect(port);
    const hostWelcome = await welcome(hostClient, port, room.ticket);
    assert.equal(hostWelcome.admitted, true);
    assert.equal(hostWelcome.self.role, 'host');
    assert.equal(hostWelcome.room.code, room.room.code);

    const guestClient = await WsClient.connect(port);
    const guestWelcome = await welcome(guestClient, port, guestJoin.ticket);
    assert.equal(guestWelcome.admitted, false);
    assert.equal(guestWelcome.self.name, 'bob');
    assert.equal(guestWelcome.participants.length, 0);

    const request = await hostClient.next('lobby.request');
    assert.equal(request.peer.peerId, guestWelcome.self.peerId);
    const update = await hostClient.next('lobby.update');
    assert.equal(update.pending.length, 1);

    hostClient.send({ type: 'lobby.admit', peerId: guestWelcome.self.peerId });
    const admitted = await guestClient.next('admitted');
    assert.equal(admitted.room.code, room.room.code);
    assert.equal(admitted.participants.length, 1);
    assert.equal(admitted.participants[0]?.name, 'alice');
    await hostClient.next('peer.join');

    guestClient.send({ type: 'chat', text: '大家好', clientId: 'c1' });
    const chat = await hostClient.next('chat');
    assert.equal(chat.message.text, '大家好');
    assert.equal(chat.message.name, 'bob');
    assert.equal(chat.message.clientId, 'c1');

    guestClient.send({
      type: 'signal',
      to: hostWelcome.self.peerId,
      data: { kind: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' }
    });
    const signal = await hostClient.next('signal');
    assert.equal(signal.from, guestWelcome.self.peerId);
    assert.equal(signal.data.kind, 'offer');

    hostClient.send({ type: 'ping', t: 42 });
    const pong = await hostClient.next('pong');
    assert.equal(pong.t, 42);

    guestClient.send({ type: 'room.lock', locked: true });
    const forbidden = await guestClient.next('error');
    assert.equal(forbidden.code, 'forbidden');

    hostClient.send({ type: 'room.lock', locked: true });
    const lockedUpdate = await guestClient.next('room.update');
    assert.equal(lockedUpdate.room.locked, true);

    hostClient.send({ type: 'room.kick', peerId: guestWelcome.self.peerId });
    const kicked = await guestClient.next('moderation');
    assert.equal(kicked.action, 'kicked');
    await hostClient.next('peer.leave', (message) => message.peerId === guestWelcome.self.peerId);

    hostClient.close();
    guestClient.close();
  });

  it('issues guest tickets without an account only with a valid invite', async () => {
    const created = await api(port, '/api/rooms', {
      method: 'POST',
      token: alice.accessToken,
      body: { title: '访客会议' }
    });
    assert.equal(created.status, 201);
    const room = created.body as unknown as JoinResponse;
    assert.ok(room.inviteToken);

    const withoutInvite = await api(port, `/api/rooms/${room.room.code}/join`, {
      method: 'POST',
      body: { displayName: '访客甲' }
    });
    assert.equal(withoutInvite.status, 403);
    assert.equal(codeOf(withoutInvite), 'invite_required');

    const withInvite = await api(port, `/api/rooms/${room.room.code}/join`, {
      method: 'POST',
      body: { displayName: '访客甲', inviteToken: room.inviteToken }
    });
    assert.equal(withInvite.status, 200, JSON.stringify(withInvite.body));
    const guest = withInvite.body as unknown as JoinResponse;
    assert.equal(guest.self.guest, true);

    const client = await WsClient.connect(port);
    const guestWelcome = await welcome(client, port, guest.ticket);
    assert.equal(guestWelcome.admitted, true);
    assert.equal(guestWelcome.self.guest, true);
    client.close();
  });

  it('rejects unauthenticated WebSocket messages and invalid tickets', async () => {
    const client = await WsClient.connect(port);
    client.send({ type: 'ping', t: 1 });
    const error = await client.next('error');
    assert.equal(error.code, 'protocol_error');
    await new Promise<void>((resolve) => {
      client.close();
      setTimeout(resolve, 50);
    });

    const bad = await WsClient.connect(port);
    bad.send({ type: 'hello', v: 1, ticket: 'not-a-ticket' });
    await new Promise<void>((resolve) => {
      bad.close();
      setTimeout(resolve, 50);
    });
  });

  it('creates a dial-in room and hands the gateway a join ticket', async () => {
    const created = await api(port, '/api/rooms', {
      method: 'POST',
      token: alice.accessToken,
      body: { title: '电话可拨入', dialIn: '+86 21 555 0100' }
    });
    assert.equal(created.status, 201);
    const room = created.body.room as { code: string; dialIn?: string | null };
    assert.equal(room.dialIn, '+86215550100');

    const resolved = await api(port, '/api/gateway/resolve', {
      method: 'POST',
      headers: { 'x-openmeet-gateway': 'gateway-test-token' },
      body: { number: '+86215550100', displayName: '电话接入' }
    });
    assert.equal(resolved.status, 200);
    const join = resolved.body as unknown as JoinResponse;
    assert.equal(join.room.code, room.code);
    assert.equal(join.self.displayName, '电话接入');
    assert.ok(join.ticket);

    // the ticket behaves like any guest join: it reaches welcome over WS
    const client = await WsClient.connect(port);
    const hello = await welcome(client, port, join.ticket);
    assert.equal(hello.self.name, '电话接入');
    assert.equal(hello.room.code, room.code);
    client.close();
  });

  it('refuses gateway resolve without the shared token, and unknown numbers', async () => {
    const anonymous = await api(port, '/api/gateway/resolve', {
      method: 'POST',
      body: { number: '+86215550100' }
    });
    assert.equal(anonymous.status, 401);
    assert.equal(codeOf(anonymous), 'gateway_unauthorized');

    const wrong = await api(port, '/api/gateway/resolve', {
      method: 'POST',
      headers: { 'x-openmeet-gateway': 'nope-not-this-token' },
      body: { number: '+86215550100' }
    });
    assert.equal(wrong.status, 401);

    const unknown = await api(port, '/api/gateway/resolve', {
      method: 'POST',
      headers: { 'x-openmeet-gateway': 'gateway-test-token' },
      body: { number: '0000000' }
    });
    assert.equal(unknown.status, 404);
    assert.equal(codeOf(unknown), 'room_not_found');
  });

  it('rejects a dial-in number already used by a live room and malformed numbers', async () => {
    const first = await api(port, '/api/rooms', {
      method: 'POST',
      token: alice.accessToken,
      body: { title: '独占号码', dialIn: '9000' }
    });
    assert.equal(first.status, 201);

    const clash = await api(port, '/api/rooms', {
      method: 'POST',
      token: alice.accessToken,
      body: { title: '重复号码', dialIn: '9000' }
    });
    assert.equal(clash.status, 409);
    assert.equal(codeOf(clash), 'dial_in_taken');

    const malformed = await api(port, '/api/rooms', {
      method: 'POST',
      token: alice.accessToken,
      body: { title: '非法号码', dialIn: '12' }
    });
    assert.equal(malformed.status, 400);
    assert.equal(codeOf(malformed), 'invalid_request');
  });

  it('ends a room when the host ends it', async () => {
    const created = await api(port, '/api/rooms', {
      method: 'POST',
      token: bob.accessToken,
      body: { title: '临时会议' }
    });
    assert.equal(created.status, 201);
    const room = created.body as unknown as JoinResponse;

    const hostClient = await WsClient.connect(port);
    const hostWelcome = await welcome(hostClient, port, room.ticket);
    assert.equal(hostWelcome.self.role, 'host');
    hostClient.send({ type: 'room.end' });
    const ended = await hostClient.next('room.ended');
    assert.equal(ended.reason, 'host_ended');
    assert.equal(ended.byName, 'bob');

    const gone = await api(port, `/api/rooms/${room.room.code}/join`, {
      method: 'POST',
      token: alice.accessToken,
      body: {}
    });
    assert.equal(gone.status, 410);
    assert.equal(codeOf(gone), 'room_ended');
  });

  it('lets only the host reopen an ended room, keeping code and password', async () => {
    const created = await api(port, '/api/rooms', {
      method: 'POST',
      token: bob.accessToken,
      body: { title: '周会', password: 'abcd' }
    });
    assert.equal(created.status, 201);
    const room = created.body as unknown as JoinResponse;
    const code = room.room.code;

    const hostClient = await WsClient.connect(port);
    await welcome(hostClient, port, room.ticket);
    hostClient.send({ type: 'room.end' });
    await hostClient.next('room.ended');

    // A stranger cannot resurrect somebody else's meeting, even knowing the code.
    const asOther = await api(port, `/api/rooms/${code}/join`, {
      method: 'POST',
      token: alice.accessToken,
      body: { password: 'abcd' }
    });
    assert.equal(asOther.status, 410);
    assert.equal(codeOf(asOther), 'room_ended');

    const reopened = await api(port, `/api/rooms/${code}/join`, {
      method: 'POST',
      token: bob.accessToken,
      body: {}
    });
    assert.equal(reopened.status, 200);
    const again = reopened.body as unknown as JoinResponse;
    assert.equal(again.room.code, code, 'the same code must come back');
    assert.equal(again.room.title, '周会');

    // The password survived the reopen: without it the join is refused.
    const noPassword = await api(port, `/api/rooms/${code}/join`, {
      method: 'POST',
      token: alice.accessToken,
      body: {}
    });
    assert.equal(codeOf(noPassword), 'password_required');

    const withPassword = await api(port, `/api/rooms/${code}/join`, {
      method: 'POST',
      token: alice.accessToken,
      body: { password: 'abcd' }
    });
    assert.equal(withPassword.status, 200);
  });
});

describe('OpenMeet LAN mode', () => {
  let running: RunningServer;

  before(async () => {
    running = await startServer({
      mode: 'lan',
      host: '127.0.0.1',
      port: 0,
      jwtSecret: 'lan-test-secret-'.repeat(4),
      stunUrls: [],
      turn: { mode: 'off' },
      logger: silentLogger
    });
  });

  after(async () => {
    await running.close();
  });

  it('disables accounts and creates ephemeral LAN rooms', async () => {
    const info = await api(running.port, '/api/server');
    assert.equal(info.status, 200);
    assert.equal((info.body as unknown as ServerInfo).mode, 'lan');

    const auth = await api(running.port, '/api/auth/login', {
      method: 'POST',
      body: { username: 'someone', password: 'does-not-matter' }
    });
    assert.equal(auth.status, 403);
    assert.equal(codeOf(auth), 'lan_mode');

    const created = await running.manager.createLanRoom('客厅主机', { title: '局域网会议' });
    assert.ok(created.inviteToken);
    assert.equal(created.room.kind, 'lan');
    assert.equal(created.self.host, true);

    const wrongInvite = await api(running.port, '/api/lan/join', {
      method: 'POST',
      body: { roomId: created.room.id, inviteToken: 'x'.repeat(40), displayName: '访客' }
    });
    assert.equal(wrongInvite.status, 403);
    assert.equal(codeOf(wrongInvite), 'invalid_invite');

    const joined = await api(running.port, '/api/lan/join', {
      method: 'POST',
      body: {
        roomId: created.room.id,
        inviteToken: created.inviteToken,
        displayName: '访客乙'
      }
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const guest = joined.body as unknown as JoinResponse;
    assert.equal(guest.room.id, created.room.id);
    assert.equal(guest.self.guest, true);

    const hostClient = await WsClient.connect(running.port);
    const hostWelcome = await welcome(hostClient, running.port, created.ticket);
    assert.equal(hostWelcome.admitted, true);

    const guestClient = await WsClient.connect(running.port);
    const guestWelcome = await welcome(guestClient, running.port, guest.ticket);
    assert.equal(guestWelcome.admitted, true);
    await hostClient.next('peer.join', (message) => message.peer.peerId === guestWelcome.self.peerId);

    hostClient.close();
    guestClient.close();
  });

  it('collects LAN HTTP endpoints for the invitation', () => {
    const endpoints = running.lanEndpoints();
    assert.ok(Array.isArray(endpoints));
    for (const endpoint of endpoints) {
      assert.match(endpoint, /^http:\/\//);
      assert.ok(endpoint.endsWith(`:${running.port}`));
      assert.equal(normalizeLanEndpoint(endpoint), endpoint);
    }
    const invite: InvitePayload = {
      v: 1,
      kind: 'lan',
      title: 'LAN',
      code: 'ABCDEFGHJ',
      token: 'a'.repeat(43),
      rid: 'r_1234567890',
      endpoints
    };
    if (endpoints.length > 0) {
      assert.deepEqual(decodeInvite(encodeInvite(invite)), invite);
    }
  });
});
