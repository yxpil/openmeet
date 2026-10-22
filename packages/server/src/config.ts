import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_ROOM_MAX_PARTICIPANTS,
  DEFAULT_STUN_URL,
  HOST_GRACE_MS,
  JOIN_TICKET_TTL_SECONDS,
  MAX_ROOM_PARTICIPANTS,
  PROTOCOL_VERSION,
  REFRESH_TOKEN_TTL_MS,
  ROOM_EMPTY_TTL_MS
} from '@openmeet/shared';
import type { LogLevel } from './log.js';

export const SERVER_VERSION = '0.1.0';
export const LAN_DEFAULT_PORT = 45871;
export { PROTOCOL_VERSION };

export type TurnMode = 'off' | 'embedded' | 'coturn';

export interface TurnConfig {
  mode: TurnMode;
  port: number;
  publicHost: string | null;
  username: string | null;
  password: string | null;
  realm: string;
  secret: string | null;
  urls: string[];
  ttlSeconds: number;
}

export interface ServerConfig {
  mode: 'server' | 'lan';
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  serverName: string;
  publicUrl: string | null;
  jwtSecret: string;
  inviteSecret: string;
  /** Shared bearer the interop gateway presents; empty disables the gateway API. */
  gatewayToken: string;
  registration: 'open' | 'closed';
  allowGuests: boolean;
  maxParticipants: number;
  allowedOrigins: string[] | '*';
  trustProxy: boolean;
  stunUrls: string[];
  turn: TurnConfig;
  logLevel: LogLevel;
  accessTokenTtlSeconds: number;
  refreshTokenTtlMs: number;
  joinTicketTtlSeconds: number;
  hostGraceMs: number;
  roomEmptyTtlMs: number;
}

export interface PartialConfig extends Partial<Omit<ServerConfig, 'turn'>> {
  turn?: Partial<TurnConfig>;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function deriveInviteSecret(jwtSecret: string): string {
  return createHmac('sha256', jwtSecret).update('openmeet-invite').digest('hex');
}

export function resolveConfig(partial: PartialConfig = {}): ServerConfig {
  const mode = partial.mode ?? 'server';
  const dataDir = resolve(partial.dataDir ?? process.env.OPENMEET_DATA_DIR ?? './data');
  const turnMode = (partial.turn?.mode ??
    (process.env.OPENMEET_TURN_MODE as TurnMode | undefined) ??
    'off') as TurnMode;
  const jwtSecret = partial.jwtSecret ?? process.env.OPENMEET_JWT_SECRET ?? randomBytes(48).toString('base64url');

  return {
    mode,
    host: partial.host ?? process.env.OPENMEET_HOST ?? '::',
    port:
      partial.port ??
      envInt(process.env.OPENMEET_PORT, mode === 'lan' ? LAN_DEFAULT_PORT : 8787, 0, 65535),
    dataDir,
    dbPath: partial.dbPath ?? process.env.OPENMEET_DB_PATH ?? join(dataDir, 'openmeet.db'),
    serverName: partial.serverName ?? process.env.OPENMEET_SERVER_NAME ?? 'OpenMeet Server',
    publicUrl: partial.publicUrl ?? (process.env.OPENMEET_PUBLIC_URL || null),
    jwtSecret,
    gatewayToken: partial.gatewayToken ?? process.env.OPENMEET_GATEWAY_TOKEN ?? '',
    inviteSecret: partial.inviteSecret ?? deriveInviteSecret(jwtSecret),
    registration:
      partial.registration ?? ((process.env.OPENMEET_REGISTRATION ?? 'open') === 'closed' ? 'closed' : 'open'),
    allowGuests: partial.allowGuests ?? envBool(process.env.OPENMEET_ALLOW_GUESTS, true),
    maxParticipants:
      partial.maxParticipants ??
      envInt(process.env.OPENMEET_MAX_PARTICIPANTS, MAX_ROOM_PARTICIPANTS, 2, MAX_ROOM_PARTICIPANTS),
    allowedOrigins:
      partial.allowedOrigins ??
      (process.env.OPENMEET_ALLOWED_ORIGINS && process.env.OPENMEET_ALLOWED_ORIGINS !== '*'
        ? splitList(process.env.OPENMEET_ALLOWED_ORIGINS)
        : '*'),
    trustProxy: partial.trustProxy ?? envBool(process.env.OPENMEET_TRUST_PROXY, false),
    stunUrls: partial.stunUrls ?? (process.env.OPENMEET_STUN_URLS !== undefined ? splitList(process.env.OPENMEET_STUN_URLS) : [DEFAULT_STUN_URL]),
    turn: {
      mode: turnMode,
      port: partial.turn?.port ?? envInt(process.env.OPENMEET_TURN_PORT, 3478, 1, 65535),
      publicHost: partial.turn?.publicHost ?? (process.env.OPENMEET_TURN_PUBLIC_HOST || null),
      username: partial.turn?.username ?? (process.env.OPENMEET_TURN_USERNAME || null),
      password: partial.turn?.password ?? (process.env.OPENMEET_TURN_PASSWORD || null),
      realm: partial.turn?.realm ?? process.env.OPENMEET_TURN_REALM ?? 'openmeet',
      secret: partial.turn?.secret ?? (process.env.OPENMEET_TURN_SECRET || null),
      urls: partial.turn?.urls ?? splitList(process.env.OPENMEET_TURN_URLS),
      ttlSeconds: partial.turn?.ttlSeconds ?? envInt(process.env.OPENMEET_TURN_TTL, 43200, 60, 86400 * 7)
    },
    logLevel: partial.logLevel ?? ((process.env.OPENMEET_LOG_LEVEL as LogLevel | undefined) ?? 'info'),
    accessTokenTtlSeconds: partial.accessTokenTtlSeconds ?? ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlMs: partial.refreshTokenTtlMs ?? REFRESH_TOKEN_TTL_MS,
    joinTicketTtlSeconds: partial.joinTicketTtlSeconds ?? JOIN_TICKET_TTL_SECONDS,
    hostGraceMs: partial.hostGraceMs ?? HOST_GRACE_MS,
    roomEmptyTtlMs: partial.roomEmptyTtlMs ?? ROOM_EMPTY_TTL_MS
  };
}

export function validateTurnConfig(config: TurnConfig): void {
  if (config.mode === 'embedded') {
    if (!config.publicHost) throw new Error('OPENMEET_TURN_PUBLIC_HOST is required for embedded TURN');
    if (!config.username || !config.password) {
      throw new Error('OPENMEET_TURN_USERNAME and OPENMEET_TURN_PASSWORD are required for embedded TURN');
    }
  }
  if (config.mode === 'coturn') {
    if (!config.secret) throw new Error('OPENMEET_TURN_SECRET is required for coturn mode');
    if (config.urls.length === 0) throw new Error('OPENMEET_TURN_URLS is required for coturn mode');
  }
}

export function ensurePersistentSecret(config: ServerConfig): void {
  if (process.env.OPENMEET_JWT_SECRET) return;
  mkdirSync(config.dataDir, { recursive: true });
  const secretPath = join(config.dataDir, 'jwt-secret');
  try {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) {
      config.jwtSecret = existing;
      config.inviteSecret = deriveInviteSecret(existing);
      return;
    }
  } catch {
    // generate below
  }
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  config.jwtSecret = secret;
  config.inviteSecret = deriveInviteSecret(secret);
}

export function clampRoomMax(configured: number, requested: number | undefined): number {
  const cap = Math.max(2, Math.min(MAX_ROOM_PARTICIPANTS, configured));
  const fallback = Math.min(DEFAULT_ROOM_MAX_PARTICIPANTS, cap);
  if (requested === undefined) return fallback;
  if (!Number.isInteger(requested)) return fallback;
  return Math.max(2, Math.min(cap, requested));
}
