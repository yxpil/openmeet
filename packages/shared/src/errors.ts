export const ERROR_CODES = {
  invalidRequest: 'invalid_request',
  unauthorized: 'unauthorized',
  invalidCredentials: 'invalid_credentials',
  invalidToken: 'invalid_token',
  passwordRequired: 'password_required',
  wrongPassword: 'wrong_password',
  forbidden: 'forbidden',
  inviteRequired: 'invite_required',
  invalidInvite: 'invalid_invite',
  guestsDisabled: 'guests_disabled',
  registrationClosed: 'registration_closed',
  lanMode: 'lan_mode',
  roomNotFound: 'room_not_found',
  roomEnded: 'room_ended',
  roomLocked: 'room_locked',
  roomFull: 'room_full',
  usernameTaken: 'username_taken',
  rateLimited: 'rate_limited',
  payloadTooLarge: 'payload_too_large',
  notFound: 'not_found',
  internalError: 'internal_error',
  protocolError: 'protocol_error',
  notAdmitted: 'not_admitted',
  unknownPeer: 'unknown_peer',
  dialInTaken: 'dial_in_taken',
  gatewayUnauthorized: 'gateway_unauthorized'
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function apiErrorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
