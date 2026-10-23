import { normalizeServerUrl } from '@openmeet/shared';
import type {
  AuthResponse,
  JoinResponse,
  ServerInfo,
  User
} from '@openmeet/shared';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  refresh?: () => Promise<string | null>;
  timeoutMs?: number;
}

export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const base = normalizeServerUrl(baseUrl);
  if (!base) throw new ApiRequestError(0, 'invalid_server', '服务器地址不合法');
  let token = options.token ?? null;
  let retried = false;

  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000)
      });
    } catch {
      throw new ApiRequestError(0, 'network_error', '无法连接到服务器，请检查地址与网络');
    }

    const payload = await parseBody(response);
    if (response.ok) return payload as T;

    const errorBody = payload as ApiErrorBody;
    const code = errorBody.error?.code ?? `http_${response.status}`;
    const message = errorBody.error?.message ?? `请求失败（${response.status}）`;
    if (
      response.status === 401 &&
      token &&
      code === 'unauthorized' &&
      options.refresh &&
      !retried
    ) {
      retried = true;
      const refreshed = await options.refresh();
      if (refreshed) {
        token = refreshed;
        continue;
      }
    }
    throw new ApiRequestError(response.status, code, message);
  }
}

export function probeServer(serverUrl: string, timeoutMs = 8000): Promise<ServerInfo> {
  return apiRequest<ServerInfo>(serverUrl, '/api/server', { timeoutMs });
}

export interface LoginInput {
  username: string;
  password: string;
  displayName?: string;
}

export function login(serverUrl: string, input: LoginInput): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(serverUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: input.username, password: input.password }
  });
}

export function register(serverUrl: string, input: LoginInput): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(serverUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      username: input.username,
      password: input.password,
      displayName: input.displayName
    }
  });
}

export function fetchMe(
  serverUrl: string,
  token: string,
  refresh: () => Promise<string | null>
): Promise<{ user: User }> {
  return apiRequest<{ user: User }>(serverUrl, '/api/auth/me', { token, refresh });
}

export interface CreateRoomInput {
  title: string;
  password?: string;
  lobby?: boolean;
  maxParticipants?: number;
  /** Ask the operator to route this phone number into the room (needs a gateway). */
  dialIn?: string;
}

export function createRoom(
  serverUrl: string,
  input: CreateRoomInput,
  auth: { token: string; refresh: () => Promise<string | null> }
): Promise<JoinResponse> {
  return apiRequest<JoinResponse>(serverUrl, '/api/rooms', {
    method: 'POST',
    token: auth.token,
    refresh: auth.refresh,
    body: input
  });
}

export interface JoinRoomInput {  displayName?: string;
  password?: string;
  inviteToken?: string;
}

export function joinRoom(
  serverUrl: string,
  roomCode: string,
  input: JoinRoomInput,
  auth?: { token: string; refresh: () => Promise<string | null> }
): Promise<JoinResponse> {
  return apiRequest<JoinResponse>(
    serverUrl,
    `/api/rooms/${encodeURIComponent(roomCode)}/join`,
    {
      method: 'POST',
      token: auth?.token ?? null,
      refresh: auth?.refresh,
      body: input
    }
  );
}

/**
 * Errors that mean "not yet" — the room is not joinable at this instant but may
 * become so, so a waiter keeps polling. Anything else (wrong password, invalid
 * invite, guests disabled) is a fact the user must see immediately.
 */
const WAITABLE_ERRORS: ReadonlySet<string> = new Set([
  'room_not_found',
  'room_ended',
  'room_locked',
  'room_full',
  'username_taken'
]);

export interface RoomWaitHandle {
  cancel(): void;
  readonly promise: Promise<{ ok: boolean; code: string; message: string }>;
}

/**
 * Probe the real join endpoint until the room lets this caller in. Deliberately
 * uses join itself rather than a separate status endpoint: "could I join right
 * now" is exactly the question, and there is no second access-control surface
 * that could drift from the first. The probe ticket is discarded.
 */
export function waitForRoomOpen(
  serverUrl: string,
  roomCode: string,
  input: JoinRoomInput,
  auth?: { token: string; refresh: () => Promise<string | null> },
  intervalMs = 5000
): RoomWaitHandle {
  let cancelled = false;
  let timer: number | null = null;
  const promise = (async (): Promise<{ ok: boolean; code: string; message: string }> => {
    for (;;) {
      if (cancelled) return { ok: false, code: 'cancelled', message: '已取消等待' };
      try {
        await joinRoom(serverUrl, roomCode, input, auth);
        return { ok: true, code: 'open', message: '会议已开始' };
      } catch (error) {
        if (!(error instanceof ApiRequestError)) {
          return { ok: false, code: 'error', message: error instanceof Error ? error.message : '查询失败' };
        }
        if (!WAITABLE_ERRORS.has(error.code)) {
          return { ok: false, code: error.code, message: error.message };
        }
        // Still closed: the rate limit for join is 30/min/IP, so 5 s is safe.
        await new Promise<void>((resolve) => {
          timer = window.setTimeout(() => {
            timer = null;
            resolve();
          }, intervalMs);
        });
        if (cancelled) return { ok: false, code: 'cancelled', message: '已取消等待' };
      }
    }
  })();
  return {
    cancel() {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    },
    promise
  };
}

export interface LanJoinInput {
  roomId: string;
  inviteToken: string;
  displayName: string;
  password?: string;
}
export interface LanJoinOutcome {
  response: JoinResponse;
  endpoint: string;
}

export async function joinLanRoom(
  endpoints: string[],
  input: LanJoinInput
): Promise<LanJoinOutcome> {
  if (endpoints.length === 0) {
    throw new ApiRequestError(0, 'no_endpoints', '邀请中没有可用的局域网地址');
  }
  const attempts = endpoints.map(async (endpoint): Promise<LanJoinOutcome> => {
    const response = await apiRequest<JoinResponse>(endpoint, '/api/lan/join', {
      method: 'POST',
      body: input,
      timeoutMs: 5000
    });
    return { response, endpoint };
  });
  try {
    return await Promise.any(attempts);
  } catch (error) {
    const errors =
      error instanceof AggregateError
        ? (error.errors as unknown[]).filter((item): item is Error => item instanceof Error)
        : [];
    const apiError = errors.find(
      (item): item is ApiRequestError => item instanceof ApiRequestError && item.status > 0
    );
    throw apiError ?? errors[0] ?? new ApiRequestError(0, 'lan_failed', '无法连接局域网主机');
  }
}
