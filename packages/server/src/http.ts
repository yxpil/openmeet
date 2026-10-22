import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ApiError,
  ERROR_CODES,
  MAX_HTTP_BODY_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  USERNAME_PATTERN,
  apiErrorBody,
  errorMessage,
  normalizeServerUrl
} from '@openmeet/shared';
import type {
  AuthResponse,
  JoinResponse,
  ServerInfo,
  User
} from '@openmeet/shared';
import type { AppDatabase, UserRecord } from './db.js';
import type { ServerConfig } from './config.js';
import { SERVER_VERSION } from './config.js';
import type { RoomManager } from './rooms.js';
import type { Logger } from './log.js';
import {
  hashPassword,
  randomToken,
  sha256,
  signToken,
  verifyAccessToken,
  verifyPassword
} from './auth.js';

export interface HttpDeps {
  db: AppDatabase;
  manager: RoomManager;
  config: ServerConfig;
  logger: Logger;
  startedAt: number;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  hit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (this.buckets.size > 10_000) this.cleanup(now);
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }

  private cleanup(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

function publicUser(user: UserRecord): User {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt
  };
}

function requestIp(req: IncomingMessage, config: ServerConfig): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value) {
      const first = value.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

function applyCommonHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: ServerConfig): void {
  const origin = req.headers.origin;
  if (config.allowedOrigins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.statusCode = 204;
  res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (contentLength > MAX_HTTP_BODY_BYTES) {
    throw new ApiError(413, ERROR_CODES.payloadTooLarge, '请求体过大');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_HTTP_BODY_BYTES) {
      throw new ApiError(413, ERROR_CODES.payloadTooLarge, '请求体过大');
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, ERROR_CODES.invalidRequest, '请求体必须是合法 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, ERROR_CODES.invalidRequest, '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new ApiError(400, ERROR_CODES.invalidRequest, `${key} 格式不正确`);
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new ApiError(400, ERROR_CODES.invalidRequest, `${key} 格式不正确`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ApiError(400, ERROR_CODES.invalidRequest, `${key} 长度必须为 ${min}–${max}`);
  }
  return trimmed;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiError(400, ERROR_CODES.invalidRequest, `${key} 必须是布尔值`);
  }
  return value;
}

function optionalInteger(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError(400, ERROR_CODES.invalidRequest, `${key} 必须是整数`);
  }
  return value;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export function createHttpServer(deps: HttpDeps): {
  server: Server;
  wss: WebSocketServer;
  closeWs: () => void;
} {
  const { db, manager, config, logger } = deps;
  const limiter = new RateLimiter();
  const server = createServer((req, res) => {
    void handleRequest(req, res, deps, limiter);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES, perMessageDeflate: false });
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      try {
        socket.ping();
      } catch {
        // ignore
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  wss.on('connection', (socket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    manager.handleConnection(socket);
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const closeWs = () => {
    clearInterval(heartbeat);
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
    wss.close();
  };

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    innerDeps: HttpDeps,
    innerLimiter: RateLimiter
  ): Promise<void> {
    const started = Date.now();
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    res.setHeader('X-Request-Id', requestId);
    applyCommonHeaders(res);
    applyCors(req, res, config);
    res.on('finish', () => {
      logger.debug(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms ${requestId}`);
    });

    try {
      if (req.method === 'OPTIONS') {
        sendNoContent(res);
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          version: SERVER_VERSION,
          uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000)
        });
        return;
      }

      if (req.method === 'GET' && path === '/api/server') {
        const info: ServerInfo = {
          name: config.serverName,
          version: SERVER_VERSION,
          protocol: PROTOCOL_VERSION,
          mode: config.mode,
          registration: config.registration,
          guests: config.allowGuests,
          maxParticipants: config.maxParticipants
        };
        sendJson(res, 200, info);
        return;
      }

      if (config.mode === 'lan' && path.startsWith('/api/auth')) {
        throw new ApiError(403, ERROR_CODES.lanMode, '局域网模式不提供账号接口');
      }

      if (req.method === 'POST' && path === '/api/auth/register') {
        if (config.mode === 'lan') throw new ApiError(403, ERROR_CODES.lanMode, '局域网模式不提供账号接口');
        if (config.registration === 'closed') {
          throw new ApiError(403, ERROR_CODES.registrationClosed, '服务器已关闭注册');
        }
        const ip = requestIp(req, config);
        if (!innerLimiter.hit(`register:${ip}`, 5, 60 * 60 * 1000)) {
          throw new ApiError(429, ERROR_CODES.rateLimited, '注册请求过于频繁');
        }
        const body = await readJsonBody(req);
        const usernameRaw = requiredString(body, 'username', 3, 32);
        if (!USERNAME_PATTERN.test(usernameRaw)) {
          throw new ApiError(400, ERROR_CODES.invalidRequest, '用户名只能包含字母、数字、下划线、点和短横线');
        }
        const username = usernameRaw.toLowerCase();
        const passwordValue = body.password;
        if (typeof passwordValue !== 'string' || passwordValue.length < 8 || passwordValue.length > 128) {
          throw new ApiError(400, ERROR_CODES.invalidRequest, '密码长度必须为 8–128');
        }
        const displayName = optionalString(body, 'displayName', 40)?.trim() || usernameRaw;
        if (displayName.length > 40) throw new ApiError(400, ERROR_CODES.invalidRequest, '显示名过长');
        if (db.findUserByUsername(username)) {
          throw new ApiError(409, ERROR_CODES.usernameTaken, '用户名已被占用');
        }
        const passwordHash = await hashPassword(passwordValue);
        if (db.findUserByUsername(username)) {
          throw new ApiError(409, ERROR_CODES.usernameTaken, '用户名已被占用');
        }
        const isFirst = db.countUsers() === 0;
        let user: UserRecord;
        try {
          user = db.createUser({
            id: `u_${randomUUID()}`,
            username,
            displayName,
            passwordHash,
            role: isFirst ? 'admin' : 'user',
            createdAt: Date.now()
          });
        } catch (error) {
          if (/UNIQUE/i.test(errorMessage(error))) {
            throw new ApiError(409, ERROR_CODES.usernameTaken, '用户名已被占用');
          }
          throw error;
        }
        const response = issueAuthResponse(db, config, user, req.headers['user-agent'] ?? null);
        logger.info(`User registered: ${user.username}`);
        sendJson(res, 201, response);
        return;
      }

      if (req.method === 'POST' && path === '/api/auth/login') {
        const ip = requestIp(req, config);
        const body = await readJsonBody(req);
        const username = requiredString(body, 'username', 1, 32).toLowerCase();
        const passwordValue = body.password;
        if (typeof passwordValue !== 'string' || passwordValue.length === 0 || passwordValue.length > 128) {
          throw new ApiError(400, ERROR_CODES.invalidRequest, '请输入用户名和密码');
        }
        if (!innerLimiter.hit(`login:${ip}:${username}`, 10, 10 * 60 * 1000)) {
          throw new ApiError(429, ERROR_CODES.rateLimited, '登录尝试过于频繁，请稍后再试');
        }
        const user = db.findUserByUsername(username);
        if (!user || user.disabled) {
          await hashPassword(passwordValue);
          throw new ApiError(401, ERROR_CODES.invalidCredentials, '用户名或密码错误');
        }
        if (!(await verifyPassword(passwordValue, user.passwordHash))) {
          throw new ApiError(401, ERROR_CODES.invalidCredentials, '用户名或密码错误');
        }
        const response = issueAuthResponse(db, config, user, req.headers['user-agent'] ?? null);
        try {
          db.deleteExpiredRefreshTokens(Date.now() - 7 * 24 * 60 * 60 * 1000);
        } catch {
          // ignore
        }
        sendJson(res, 200, response);
        return;
      }

      if (req.method === 'POST' && path === '/api/auth/refresh') {
        const body = await readJsonBody(req);
        const tokenValue = body.refreshToken;
        if (typeof tokenValue !== 'string' || tokenValue.length < 20 || tokenValue.length > 256) {
          throw new ApiError(401, ERROR_CODES.invalidToken, '刷新令牌无效');
        }
        const tokenHash = sha256(tokenValue);
        const record = db.findRefreshToken(tokenHash);
        if (!record) throw new ApiError(401, ERROR_CODES.invalidToken, '刷新令牌无效');
        if (record.revokedAt !== null) {
          db.revokeAllRefreshTokens(record.userId, Date.now());
          throw new ApiError(401, ERROR_CODES.invalidToken, '刷新令牌已失效，请重新登录');
        }
        if (record.expiresAt <= Date.now()) {
          db.revokeRefreshToken(tokenHash, Date.now());
          throw new ApiError(401, ERROR_CODES.invalidToken, '登录已过期，请重新登录');
        }
        const user = db.findUserById(record.userId);
        if (!user || user.disabled) throw new ApiError(401, ERROR_CODES.invalidToken, '账号不可用');
        db.revokeRefreshToken(tokenHash, Date.now());
        const response = issueAuthResponse(db, config, user, req.headers['user-agent'] ?? null);
        sendJson(res, 200, response);
        return;
      }

      if (req.method === 'POST' && path === '/api/auth/logout') {
        const body = await readJsonBody(req);
        const tokenValue = body.refreshToken;
        if (typeof tokenValue === 'string') db.revokeRefreshToken(sha256(tokenValue), Date.now());
        sendNoContent(res);
        return;
      }

      if (req.method === 'GET' && path === '/api/auth/me') {
        const user = requireUser(req, db, config);
        sendJson(res, 200, { user: publicUser(user) });
        return;
      }

      if (req.method === 'PATCH' && path === '/api/auth/me') {
        const user = requireUser(req, db, config);
        const body = await readJsonBody(req);
        const displayName = requiredString(body, 'displayName', 1, 40);
        const updated = db.updateDisplayName(user.id, displayName);
        if (!updated) throw new ApiError(404, ERROR_CODES.notFound, '用户不存在');
        sendJson(res, 200, { user: publicUser(updated) });
        return;
      }

      if (req.method === 'GET' && path === '/api/rooms/mine') {
        if (config.mode === 'lan') throw new ApiError(403, ERROR_CODES.lanMode, '局域网模式不提供该接口');
        const user = requireUser(req, db, config);
        const limitValue = Number(url.searchParams.get('limit') ?? 30);
        const limit = Number.isFinite(limitValue) ? Math.min(100, Math.max(1, Math.floor(limitValue))) : 30;
        sendJson(res, 200, { rooms: db.listRoomsForUser(user.id, limit) });
        return;
      }

      if (req.method === 'POST' && path === '/api/rooms') {
        if (config.mode === 'lan') throw new ApiError(403, ERROR_CODES.lanMode, '局域网模式不提供该接口');
        const user = requireUser(req, db, config);
        const body = await readJsonBody(req);
        const title = requiredString(body, 'title', 1, 80);
        const password = optionalString(body, 'password', 64);
        if (password !== undefined && password.length > 0 && password.length < 4) {
          throw new ApiError(400, ERROR_CODES.invalidRequest, '房间密码长度必须为 4–64');
        }
        const lobby = optionalBoolean(body, 'lobby');
        const maxParticipants = optionalInteger(body, 'maxParticipants');
        const response = await manager.createRoomForUser(user, {
          title,
          password,
          lobby,
          maxParticipants
        });
        sendJson(res, 201, response);
        return;
      }

      const joinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
      if (req.method === 'POST' && joinMatch) {
        if (config.mode === 'lan') throw new ApiError(403, ERROR_CODES.lanMode, '局域网模式不提供该接口');
        const body = await readJsonBody(req);
        const user = optionalUser(req, db, config);
        const code = decodeURIComponent(joinMatch[1]);
        const displayName = optionalString(body, 'displayName', 40);
        const password = optionalString(body, 'password', 64);
        const inviteToken = optionalString(body, 'inviteToken', 128);
        const response = await manager.joinRoom({ code, user, displayName, password, inviteToken });
        sendJson(res, 200, response);
        return;
      }

      if (req.method === 'POST' && path === '/api/lan/join') {
        if (config.mode !== 'lan') throw new ApiError(403, ERROR_CODES.lanMode, '该接口仅在局域网模式可用');
        const ip = requestIp(req, config);
        if (!innerLimiter.hit(`lan-join:${ip}`, 30, 60 * 1000)) {
          throw new ApiError(429, ERROR_CODES.rateLimited, '请求过于频繁');
        }
        const body = await readJsonBody(req);
        const roomId = requiredString(body, 'roomId', 4, 64);
        const inviteToken = requiredString(body, 'inviteToken', 20, 128);
        const displayName = optionalString(body, 'displayName', 40);
        const password = optionalString(body, 'password', 64);
        const response = await manager.joinLan({ roomId, inviteToken, displayName, password });
        sendJson(res, 200, response);
        return;
      }

      throw new ApiError(404, ERROR_CODES.notFound, '接口不存在');
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(500, ERROR_CODES.internalError, '服务器内部错误');
      if (!(error instanceof ApiError)) {
        logger.error(`Request failed ${requestId}: ${errorMessage(error)}`);
      }
      if (!res.headersSent) sendJson(res, apiError.status, apiErrorBody(apiError.code, apiError.message));
      else res.end();
    }
  }

  return { server, wss, closeWs };
}

function issueAuthResponse(db: AppDatabase, config: ServerConfig, user: UserRecord, userAgent: string | null): AuthResponse {
  const accessToken = signToken(
    { typ: 'access', sub: user.id, name: user.displayName, role: user.role },
    config.jwtSecret,
    config.accessTokenTtlSeconds
  );
  const refreshToken = randomToken(48);
  const now = Date.now();
  db.createRefreshToken({
    tokenHash: sha256(refreshToken),
    userId: user.id,
    createdAt: now,
    expiresAt: now + config.refreshTokenTtlMs,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : null
  });
  return { user: publicUser(user), accessToken, refreshToken, expiresIn: config.accessTokenTtlSeconds };
}

function resolveUserFromRequest(req: IncomingMessage, db: AppDatabase, config: ServerConfig): UserRecord | null {
  const token = bearerToken(req);
  if (!token) return null;
  const claims = verifyAccessToken(token, config.jwtSecret);
  if (!claims) throw new ApiError(401, ERROR_CODES.unauthorized, '访问令牌无效或已过期');
  const user = db.findUserById(claims.sub);
  if (!user || user.disabled) throw new ApiError(401, ERROR_CODES.unauthorized, '账号不可用');
  return user;
}

function optionalUser(req: IncomingMessage, db: AppDatabase, config: ServerConfig): UserRecord | null {
  return resolveUserFromRequest(req, db, config);
}

function requireUser(req: IncomingMessage, db: AppDatabase, config: ServerConfig): UserRecord {
  const user = resolveUserFromRequest(req, db, config);
  if (!user) throw new ApiError(401, ERROR_CODES.unauthorized, '请先登录');
  return user;
}

export function normalizeListenHost(host: string): string {
  return host === '' ? '::' : host;
}

export async function listenServer(server: Server, port: number, host: string): Promise<AddressInfo> {
  const targetHost = normalizeListenHost(host);
  return new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, targetHost);
  });
}
