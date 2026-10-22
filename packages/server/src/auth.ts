import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import type { AccessTokenClaims, JoinTicketClaims } from '@openmeet/shared';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEM
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n > 1 << 17 || r > 16 || p > 4) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const derived = (await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAX_MEM
    })) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signHs256(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

type TokenPayload = Record<string, unknown> & { typ: string; iat: number; exp: number; jti: string };

export function signToken(claims: Record<string, unknown> & { typ: string }, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlJson({ ...claims, iat: now, exp: now + ttlSeconds, jti: randomBytes(12).toString('base64url') });
  const input = `${header}.${payload}`;
  return `${input}.${signHs256(input, secret)}`;
}

export function verifyToken<T extends TokenPayload>(token: string, secret: string, expectedType: string): T | null {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const expected = signHs256(`${header}.${payload}`, secret);
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== providedBuffer.length) return null;
    if (!timingSafeEqual(expectedBuffer, providedBuffer)) return null;
    const headerValue = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (headerValue.alg !== 'HS256') return null;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
    if (!value || value.typ !== expectedType) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof value.exp !== 'number' || value.exp <= now) return null;
    if (typeof value.iat !== 'number' || value.iat > now + 60) return null;
    return value;
  } catch {
    return null;
  }
}

export function verifyAccessToken(token: string, secret: string): AccessTokenClaims | null {
  return verifyToken<AccessTokenClaims & TokenPayload>(token, secret, 'access');
}

export function verifyJoinTicket(token: string, secret: string): JoinTicketClaims | null {
  return verifyToken<JoinTicketClaims & TokenPayload>(token, secret, 'join');
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function makeInviteToken(secret: string, roomId: string): string {
  return createHmac('sha256', secret).update(`invite:${roomId}`).digest('base64url');
}

export function inviteTokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function makeTurnCredential(secret: string, username: string): string {
  return createHmac('sha1', secret).update(username).digest('base64');
}
