import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RoomSummary, UserRole } from '@openmeet/shared';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  revokedAt: number | null;
}

export interface CreateRoomRecord {
  id: string;
  code: string;
  title: string;
  hostUserId: string;
  passwordHash: string | null;
  lobby: boolean;
  maxParticipants: number;
  createdAt: number;
}

type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function mapUser(row: Row): UserRecord {
  return {
    id: asString(row.id),
    username: asString(row.username),
    displayName: asString(row.display_name),
    passwordHash: asString(row.password_hash),
    role: row.role === 'admin' ? 'admin' : 'user',
    disabled: asNumber(row.disabled) === 1,
    createdAt: asNumber(row.created_at)
  };
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        user_agent TEXT
      );

      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        host_user_id TEXT NOT NULL REFERENCES users(id),
        password_hash TEXT,
        lobby INTEGER NOT NULL DEFAULT 0 CHECK (lobby IN (0,1)),
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
        max_participants INTEGER NOT NULL DEFAULT 8,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        ended_reason TEXT
      );

      CREATE TABLE room_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        guest_name TEXT,
        role TEXT NOT NULL CHECK (role IN ('host','cohost','participant')),
        joined_at INTEGER NOT NULL,
        left_at INTEGER
      );

      CREATE INDEX idx_rooms_host ON rooms(host_user_id, created_at DESC);
      CREATE INDEX idx_rooms_status ON rooms(status, created_at DESC);
      CREATE INDEX idx_participants_room ON room_participants(room_id, joined_at);
      CREATE INDEX idx_participants_user ON room_participants(user_id, joined_at DESC);
      CREATE INDEX idx_refresh_user ON refresh_tokens(user_id, expires_at);
    `
  }
];

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as Row | undefined;
    const current = row ? asNumber(row.version) : 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, Date.now());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // best effort
    }
    this.db.close();
  }

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as Row;
    return asNumber(row.count);
  }

  createUser(input: {
    id: string;
    username: string;
    displayName: string;
    passwordHash: string;
    role: UserRole;
    createdAt: number;
  }): UserRecord {
    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.id, input.username.toLowerCase(), input.displayName, input.passwordHash, input.role, input.createdAt);
    const user = this.findUserById(input.id);
    if (!user) throw new Error('Failed to read created user');
    return user;
  }

  findUserById(id: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? mapUser(row) : null;
  }

  findUserByUsername(username: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as
      | Row
      | undefined;
    return row ? mapUser(row) : null;
  }

  updateDisplayName(id: string, displayName: string): UserRecord | null {
    this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
    return this.findUserById(id);
  }

  ensureLanHostUser(): UserRecord {
    const existing = this.findUserById('lan-host');
    if (existing) return existing;
    return this.createUser({
      id: 'lan-host',
      username: 'lan-host',
      displayName: 'LAN Host',
      passwordHash: '!',
      role: 'user',
      createdAt: Date.now()
    });
  }

  createRefreshToken(input: {
    tokenHash: string;
    userId: string;
    expiresAt: number;
    createdAt: number;
    userAgent: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (token_hash, user_id, created_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.tokenHash, input.userId, input.createdAt, input.expiresAt, input.userAgent);
  }

  findRefreshToken(tokenHash: string): RefreshTokenRecord | null {
    const row = this.db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as
      | Row
      | undefined;
    if (!row) return null;
    return {
      tokenHash: asString(row.token_hash),
      userId: asString(row.user_id),
      expiresAt: asNumber(row.expires_at),
      revokedAt: asNullableNumber(row.revoked_at)
    };
  }

  revokeRefreshToken(tokenHash: string, at: number): void {
    this.db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(at, tokenHash);
  }

  revokeAllRefreshTokens(userId: string, at: number): void {
    this.db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, userId);
  }

  deleteExpiredRefreshTokens(before: number): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(before);
  }

  createRoom(input: CreateRoomRecord): void {
    this.db
      .prepare(
        `INSERT INTO rooms
          (id, code, title, host_user_id, password_hash, lobby, max_participants, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.code,
        input.title,
        input.hostUserId,
        input.passwordHash,
        input.lobby ? 1 : 0,
        input.maxParticipants,
        input.createdAt
      );
  }

  roomCodeExists(code: string): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM rooms WHERE code = ?').get(code) as Row | undefined;
    return Boolean(row);
  }

  setRoomLocked(roomId: string, locked: boolean): void {
    this.db.prepare('UPDATE rooms SET locked = ? WHERE id = ? AND status = \'active\'').run(locked ? 1 : 0, roomId);
  }

  markRoomEnded(roomId: string, at: number, reason: string): void {
    this.db
      .prepare(`UPDATE rooms SET status = 'ended', ended_at = ?, ended_reason = ? WHERE id = ? AND status = 'active'`)
      .run(at, reason, roomId);
  }

  markAllActiveRoomsEnded(at: number, reason: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(`UPDATE rooms SET status = 'ended', ended_at = ?, ended_reason = ? WHERE status = 'active'`)
        .run(at, reason);
      this.db.prepare('UPDATE room_participants SET left_at = ? WHERE left_at IS NULL').run(at);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addParticipant(input: {
    roomId: string;
    userId: string | null;
    guestName: string | null;
    role: string;
    joinedAt: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO room_participants (room_id, user_id, guest_name, role, joined_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.roomId, input.userId, input.guestName, input.role, input.joinedAt);
    return Number(result.lastInsertRowid);
  }

  setParticipantLeft(participantId: number, at: number): void {
    this.db.prepare('UPDATE room_participants SET left_at = ? WHERE id = ? AND left_at IS NULL').run(at, participantId);
  }

  listRoomsForUser(userId: string, limit: number): RoomSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.code, r.title, r.status, r.created_at, r.ended_at, r.max_participants,
                CASE WHEN r.host_user_id = ? THEN 'host' ELSE 'participant' END AS user_role,
                (SELECT COUNT(*) FROM room_participants p WHERE p.room_id = r.id) AS participant_count
         FROM rooms r
         WHERE r.host_user_id = ?
            OR EXISTS (SELECT 1 FROM room_participants p WHERE p.room_id = r.id AND p.user_id = ?)
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .all(userId, userId, userId, limit) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      code: asString(row.code),
      title: asString(row.title),
      role: row.user_role === 'host' ? 'host' : 'participant',
      status: row.status === 'active' ? 'active' : 'ended',
      createdAt: asNumber(row.created_at),
      endedAt: asNullableNumber(row.ended_at),
      participantCount: asNumber(row.participant_count),
      maxParticipants: asNumber(row.max_participants)
    }));
  }
}
