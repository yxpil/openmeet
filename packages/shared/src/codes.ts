import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_PATTERN } from './constants.js';

export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

export function formatRoomCode(code: string): string {
  return code.replace(/(.{3})/g, '$1-').replace(/-$/, '');
}

export function generateRoomCode(random: (max: number) => number): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[random(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeServerUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function normalizeLanEndpoint(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function makeWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}
