import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { safeStorage } from 'electron';
import type {
  HistoryAddChatInput,
  HistoryEndInput,
  HistoryStartInput,
  LocalChatRecord,
  ScheduledJoinInput,
  ScheduledJoinRecord,
  MeetingRecord,
  SessionSaveInput,
  StoredSessionInfo
} from '../shared/ipc.js';

type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function asBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array();
}

function mapMeeting(row: Row): MeetingRecord {
  return {
    id: asString(row.id),
    kind: row.kind === 'lan' ? 'lan' : 'server',
    serverUrl: row.server_url === null || row.server_url === undefined ? null : asString(row.server_url),
    roomCode: asString(row.room_code),
    roomTitle: asString(row.room_title),
    role: asString(row.role),
    startedAt: asNumber(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : asNumber(row.ended_at),
    participantCount: asNumber(row.participant_count),
    chatCount: asNumber(row.chat_count)
  };
}

function mapChat(row: Row): LocalChatRecord {
  return {
    id: asString(row.id),
    meetingId: asString(row.meeting_id),
    fromPeerId: row.from_peer_id === null || row.from_peer_id === undefined ? null : asString(row.from_peer_id),
    fromName: asString(row.from_name),
    body: asString(row.body),
    sentAt: asNumber(row.sent_at),
    isSelf: asNumber(row.is_self) === 1,
    clientId: row.client_id === null || row.client_id === undefined ? null : asString(row.client_id)
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    server_url TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    refresh_token BLOB NOT NULL,
    token_format TEXT NOT NULL CHECK (token_format IN ('safeStorage-v1','plain-v0')),
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('server','lan')),
    server_url TEXT,
    room_code TEXT NOT NULL,
    room_title TEXT NOT NULL,
    role TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    participant_count INTEGER NOT NULL DEFAULT 0,
    chat_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    from_peer_id TEXT,
    from_name TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    is_self INTEGER NOT NULL DEFAULT 0,
    client_id TEXT
  );

  CREATE TABLE IF NOT EXISTS scheduled_joins (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'server',
    server_url TEXT NOT NULL,
    room_code TEXT NOT NULL,
    room_title TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password BLOB,
    password_format TEXT NOT NULL CHECK (password_format IN ('safeStorage-v1','plain-v0')),
    lobby INTEGER NOT NULL DEFAULT 0,
    max_participants INTEGER NOT NULL DEFAULT 8,
    at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_joins(at);
  CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_meeting ON chat_messages(meeting_id, sent_at);
`;

export class LocalDatabase {
  private readonly db: DatabaseSync;
  private storageAvailable = false;

  private constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.db
      .prepare("INSERT INTO schema_meta(key, value) VALUES('schema_version','1') ON CONFLICT(key) DO NOTHING")
      .run();
  }

  /** Columns added after the first scheduled-join build; old rows stay valid. */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(scheduled_joins)').all() as Row[]).map((row) =>
        asString(row.name)
      )
    );
    if (!columns.has('kind')) {
      this.db.exec("ALTER TABLE scheduled_joins ADD COLUMN kind TEXT NOT NULL DEFAULT 'server'");
    }
    if (!columns.has('lobby')) {
      this.db.exec('ALTER TABLE scheduled_joins ADD COLUMN lobby INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('max_participants')) {
      this.db.exec('ALTER TABLE scheduled_joins ADD COLUMN max_participants INTEGER NOT NULL DEFAULT 8');
    }
  }

  static async open(path: string): Promise<LocalDatabase> {
    const database = new LocalDatabase(path);
    try {
      database.storageAvailable = await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      database.storageAvailable = false;
    }
    return database;
  }

  get usesSafeStorage(): boolean {
    return this.storageAvailable;
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // best effort
    }
    this.db.close();
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? asString(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, Date.now());
  }

  listSessions(): StoredSessionInfo[] {
    const rows = this.db
      .prepare('SELECT server_url, username, display_name, updated_at FROM sessions ORDER BY updated_at DESC')
      .all() as Row[];
    return rows.map((row) => ({
      serverUrl: asString(row.server_url),
      username: asString(row.username),
      displayName: asString(row.display_name),
      updatedAt: asNumber(row.updated_at)
    }));
  }

  async saveSession(input: SessionSaveInput): Promise<void> {
    let blob: Uint8Array;
    let format: 'safeStorage-v1' | 'plain-v0';
    if (this.storageAvailable) {
      blob = new Uint8Array(await safeStorage.encryptStringAsync(input.refreshToken));
      format = 'safeStorage-v1';
    } else {
      blob = new TextEncoder().encode(input.refreshToken);
      format = 'plain-v0';
    }
    this.db
      .prepare(
        `INSERT INTO sessions(server_url, username, display_name, refresh_token, token_format, updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(server_url) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           refresh_token = excluded.refresh_token,
           token_format = excluded.token_format,
           updated_at = excluded.updated_at`
      )
      .run(input.serverUrl, input.username, input.displayName, blob, format, Date.now());
  }

  async loadRefreshToken(serverUrl: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT refresh_token, token_format FROM sessions WHERE server_url = ?')
      .get(serverUrl) as Row | undefined;
    if (!row) return null;
    const blob = asBlob(row.refresh_token);
    if (row.token_format === 'safeStorage-v1') {
      if (!this.storageAvailable) return null;
      try {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(blob));
        return decrypted.result || null;
      } catch {
        return null;
      }
    }
    return new TextDecoder().decode(blob);
  }

  clearSession(serverUrl: string): void {
    this.db.prepare('DELETE FROM sessions WHERE server_url = ?').run(serverUrl);
  }

  /**
   * Scheduled joins. The room password is a secret, so it gets the same
   * treatment as a refresh token: system safeStorage when available, and an
   * explicit format marker so a later run knows how to read it back.
   */
  async saveScheduledJoin(input: ScheduledJoinInput): Promise<void> {
    let blob: Uint8Array | null = null;
    let format: 'safeStorage-v1' | 'plain-v0' = 'plain-v0';
    if (input.password) {
      if (this.storageAvailable) {
        blob = new Uint8Array(await safeStorage.encryptStringAsync(input.password));
        format = 'safeStorage-v1';
      } else {
        blob = new TextEncoder().encode(input.password);
      }
    }
    this.db
      .prepare(
        `INSERT INTO scheduled_joins
          (id, kind, server_url, room_code, room_title, display_name, password, password_format,
           lobby, max_participants, at, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           server_url = excluded.server_url,
           room_code = excluded.room_code,
           room_title = excluded.room_title,
           display_name = excluded.display_name,
           password = excluded.password,
           password_format = excluded.password_format,
           lobby = excluded.lobby,
           max_participants = excluded.max_participants,
           at = excluded.at,
           created_at = excluded.created_at`
      )
      .run(
        input.id,
        input.kind,
        input.serverUrl,
        input.roomCode,
        input.roomTitle,
        input.displayName,
        blob,
        format,
        input.lobby ? 1 : 0,
        input.maxParticipants,
        input.at,
        input.createdAt
      );
  }

  listScheduledJoins(): ScheduledJoinRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM scheduled_joins ORDER BY at ASC LIMIT 100')
      .all() as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      kind: (asString(row.kind) || 'server') as ScheduledJoinRecord['kind'],
      serverUrl: asString(row.server_url),
      roomCode: asString(row.room_code),
      roomTitle: asString(row.room_title),
      displayName: asString(row.display_name),
      at: asNumber(row.at),
      createdAt: asNumber(row.created_at),
      hasPassword: row.password !== null && row.password !== undefined,
      passwordFormat: asString(row.password_format) as 'safeStorage-v1' | 'plain-v0',
      lobby: asNumber(row.lobby) === 1,
      maxParticipants: asNumber(row.max_participants) || 8
    }));
  }

  /** Passwords are only ever decrypted at fire time, never listed to the UI. */
  async loadScheduledJoinPassword(id: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT password, password_format FROM scheduled_joins WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) return null;
    const blob = asBlob(row.password);
    if (blob.length === 0) return null;
    if (row.password_format === 'safeStorage-v1') {
      if (!this.storageAvailable) return null;
      try {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(blob));
        return decrypted.result || null;
      } catch {
        return null;
      }
    }
    return new TextDecoder().decode(blob);
  }

  removeScheduledJoin(id: string): void {
    this.db.prepare('DELETE FROM scheduled_joins WHERE id = ?').run(id);
  }

  clearScheduledJoins(): void {
    this.db.prepare('DELETE FROM scheduled_joins').run();
  }

  startMeeting(input: HistoryStartInput): string {
    const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO meetings(id, kind, server_url, room_code, room_title, role, started_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(id, input.kind, input.serverUrl, input.roomCode, input.roomTitle, input.role, input.startedAt);
    return id;
  }

  endMeeting(input: HistoryEndInput): void {
    this.db
      .prepare('UPDATE meetings SET ended_at = ?, participant_count = ? WHERE id = ?')
      .run(input.endedAt, input.participantCount, input.id);
  }

  listMeetings(limit: number): MeetingRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM meetings ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(mapMeeting);
  }

  addChat(input: HistoryAddChatInput): void {
    const row = this.db
      .prepare(
        `INSERT INTO chat_messages(id, meeting_id, from_peer_id, from_name, body, sent_at, is_self, client_id)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        input.message.id,
        input.meetingId,
        input.message.peerId,
        input.message.name,
        input.message.text,
        input.message.at,
        input.message.isSelf ? 1 : 0,
        input.message.clientId ?? null
      );
    if (row.changes > 0) {
      this.db.prepare('UPDATE meetings SET chat_count = chat_count + 1 WHERE id = ?').run(input.meetingId);
    }
  }

  listChat(meetingId: string, limit: number): LocalChatRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_messages WHERE meeting_id = ? ORDER BY sent_at ASC LIMIT ?')
      .all(meetingId, limit) as Row[];
    return rows.map(mapChat);
  }

  clearHistory(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM chat_messages; DELETE FROM meetings;');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reset(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(
        'DELETE FROM chat_messages; DELETE FROM meetings; DELETE FROM sessions; DELETE FROM scheduled_joins; DELETE FROM settings;'
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
