import {
  INVITE_PREFIX,
  INVITE_TOKEN_MAX_LENGTH,
  INVITE_TOKEN_MIN_LENGTH,
  MAX_LAN_ENDPOINTS
} from './constants.js';
import { formatRoomCode, normalizeLanEndpoint, normalizeRoomCode, normalizeServerUrl } from './codes.js';
import type { InvitePayload } from './types.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const INVITE_PATTERN = /OM1\.[A-Za-z0-9_-]+/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidInviteToken(token: string): boolean {
  return (
    token.length >= INVITE_TOKEN_MIN_LENGTH &&
    token.length <= INVITE_TOKEN_MAX_LENGTH &&
    TOKEN_PATTERN.test(token)
  );
}

export function encodeInvite(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  return INVITE_PREFIX + bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeInvite(text: string): InvitePayload | null {
  const match = text.match(INVITE_PATTERN);
  if (!match) return null;
  try {
    const raw = base64UrlToBytes(match[0].slice(INVITE_PREFIX.length));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    return validateInvite(parsed);
  } catch {
    return null;
  }
}

function validateInvite(value: unknown): InvitePayload | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (value.kind !== 'server' && value.kind !== 'lan') return null;
  if (typeof value.token !== 'string' || !isValidInviteToken(value.token)) return null;
  if (typeof value.code !== 'string') return null;
  const code = normalizeRoomCode(value.code);
  if (!code) return null;

  const rawTitle = typeof value.title === 'string' ? value.title.trim() : '';
  const title = rawTitle.slice(0, 80) || 'OpenMeet 会议';

  if (value.kind === 'server') {
    if (typeof value.server !== 'string') return null;
    const server = normalizeServerUrl(value.server);
    if (!server) return null;
    return { v: 1, kind: 'server', title, code, token: value.token, server };
  }

  if (typeof value.rid !== 'string' || value.rid.length < 4 || value.rid.length > 64) return null;
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) return null;
  if (value.endpoints.length > MAX_LAN_ENDPOINTS) return null;
  const endpoints: string[] = [];
  for (const endpoint of value.endpoints) {
    if (typeof endpoint !== 'string') continue;
    const normalized = normalizeLanEndpoint(endpoint);
    if (!normalized) continue;
    if (!endpoints.includes(normalized)) endpoints.push(normalized);
  }
  if (endpoints.length === 0) return null;
  return { v: 1, kind: 'lan', title, code, token: value.token, rid: value.rid, endpoints };
}

export function formatInviteText(payload: InvitePayload): string {
  return [
    'OpenMeet 邀请你加入会议',
    `主题：${payload.title}`,
    `房间码：${formatRoomCode(payload.code)}`,
    '',
    encodeInvite(payload)
  ].join('\n');
}
