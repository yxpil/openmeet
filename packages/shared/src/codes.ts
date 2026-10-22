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

export function normalizeLanEndpoint(input: string): string | null {  try {
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

/**
 * Canonicalise a dial-in number: digits, an optional leading +, and letters for
 * vanity extensions. Human formatting (spaces, dashes, dots, parentheses) is
 * stripped so a number pasted off a business card works, while anything a phone
 * cannot dial is rejected and never becomes an unreachable room.
 */
export function normalizeDialIn(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const stripped = input.toUpperCase().replace(/[\s().-]/g, '');
  if (!/^\+?[0-9A-Z]{3,32}$/.test(stripped)) return null;
  return stripped;
}
