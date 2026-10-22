export const PROTOCOL_VERSION = 1;

export const ACCESS_TOKEN_TTL_SECONDS = 20 * 60;
export const JOIN_TICKET_TTL_SECONDS = 4 * 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HOST_GRACE_MS = 45 * 1000;
export const ROOM_EMPTY_TTL_MS = 15 * 60 * 1000;
export const PING_INTERVAL_MS = 25 * 1000;
export const WS_IDLE_TIMEOUT_MS = 75 * 1000;

export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_WS_PAYLOAD_BYTES = 128 * 1024;
export const MAX_SDP_LENGTH = 96 * 1024;
export const MAX_CANDIDATE_LENGTH = 4 * 1024;
export const MAX_CHAT_TEXT_LENGTH = 2000;
export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_ROOM_TITLE_LENGTH = 80;
export const MAX_ROOM_PASSWORD_LENGTH = 64;
export const MIN_ROOM_PASSWORD_LENGTH = 4;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;
export const DEFAULT_ROOM_MAX_PARTICIPANTS = 8;
export const MAX_ROOM_PARTICIPANTS = 12;
export const MIN_ROOM_PARTICIPANTS = 2;
export const DEFAULT_PAGE_LIMIT = 30;

export const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
export const USERNAME_PATTERN_SOURCE = '^[a-zA-Z0-9_.-]+$';

export const API_PREFIX = '/api';
export const WS_PATH = '/ws';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 9;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{9}$/;

export const INVITE_PREFIX = 'OM1.';
export const INVITE_TOKEN_MIN_LENGTH = 20;
export const INVITE_TOKEN_MAX_LENGTH = 128;
export const MAX_LAN_ENDPOINTS = 12;

export const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';

export const WS_CLOSE = {
  normal: 1000,
  protocol: 4001,
  auth: 4002,
  roomClosed: 4003,
  removed: 4004,
  rateLimited: 4005,
  badMessage: 4006,
  serverShutdown: 4007,
  badState: 4008
} as const;
