import { BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc.js';
import type {
  ScheduledCreateInput,
  ScheduledJoinEvent,
  ScheduledJoinRecord
} from '../shared/ipc.js';
import type { LocalDatabase } from './local-db.js';
import {
  JoinScheduler,
  newScheduleId,
  validateSchedule,
  type ScheduledJoin
} from './scheduled.js';
import { normalizeRoomCode, normalizeServerUrl } from '@openmeet/shared';
import { normalizeP2pCode } from '../shared/p2p.js';
import type { ScheduledJoinKind } from '../shared/ipc.js';

/** Titles are only shown in this machine's own list, so a per-kind fallback is enough. */
function defaultTitle(kind: ScheduledJoinKind, code: string): string {
  if (kind === 'lan') return '局域网会议';
  if (kind === 'p2p') return `直连会议 ${code}`;
  return `会议 ${code.slice(0, 3)}…`;
}

function requireString(value: unknown, max: number, min = 1): string {  if (typeof value !== 'string') throw new Error('参数不合法');
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error('参数不合法');
  return text;
}

/**
 * Owns the scheduled-join lifecycle in the main process: persistence, the timer,
 * and pushing reminders/fires to the renderer. Keeping the timer here means a
 * plan still fires while the window is hidden in the tray.
 */
export class ScheduledJoinService {
  private readonly db: LocalDatabase;
  private readonly windows: () => BrowserWindow[];
  private readonly scheduler: JoinScheduler;
  private readonly store = {
    list: (): ScheduledJoin[] =>
      this.db.listScheduledJoins().map((row) => ({
        id: row.id,
        kind: row.kind,
        serverUrl: row.serverUrl,
        roomCode: row.roomCode,
        roomTitle: row.roomTitle,
        displayName: row.displayName,
        at: row.at,
        createdAt: row.createdAt,
        lobby: row.lobby,
        maxParticipants: row.maxParticipants
      })),
    remove: (id: string) => this.db.removeScheduledJoin(id)
  };

  constructor(db: LocalDatabase, windows: () => BrowserWindow[]) {
    this.db = db;
    this.windows = windows;
    this.scheduler = new JoinScheduler(this.store, {
      onFire: (item) => void this.fire(item),
      onRemind: (item) =>
        this.push(IPC.scheduledReminder, this.recordOf(item) ?? this.fromItem(item)),
      // The scheduler drops a missed plan before reporting it, so build the
      // payload from what it hands us instead of reading it back.
      onMissed: (item) => this.push(IPC.scheduledMissed, this.fromItem(item)),
      onError: (message) => console.warn('scheduled join error:', message)
    });
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  list(): ScheduledJoinRecord[] {
    return this.db.listScheduledJoins();
  }

  async create(input: unknown): Promise<ScheduledJoinRecord> {
    const value = input as Partial<ScheduledCreateInput>;
    const kind: ScheduledJoinKind =
      value?.kind === 'lan' || value?.kind === 'p2p' ? value.kind : 'server';
    const rawUrl = typeof value?.serverUrl === 'string' ? value.serverUrl.trim() : '';
    const serverUrl = kind === 'server' ? (normalizeServerUrl(rawUrl) ?? '') : '';
    if (kind === 'server' && !serverUrl) throw new Error('服务器地址不合法');
    const rawCode = requireString(value?.roomCode ?? '', 20, kind === 'lan' ? 0 : 1);
    const code = kind === 'server' ? (normalizeRoomCode(rawCode) ?? '') : normalizeP2pCode(rawCode);
    if (kind !== 'lan' && !code) throw new Error('会议号不合法');
    const displayName = requireString(value?.displayName, 40);
    const at = Number(value?.at);
    const roomTitle =
      typeof value?.roomTitle === 'string' ? value.roomTitle.trim().slice(0, 80) : '';
    const lobby = value?.lobby === true;
    const maxParticipants = Math.min(12, Math.max(2, Math.floor(Number(value?.maxParticipants) || 8)));
    const password =
      typeof value?.password === 'string' && value.password.length > 0
        ? value.password.slice(0, 64)
        : undefined;

    const validation = validateSchedule({
      at,
      kind,
      roomCode: code,
      serverUrl,
      displayName,
      now: Date.now()
    });
    if (!validation.ok) throw new Error(validation.error);

    const id = newScheduleId();
    const record: ScheduledJoinRecord = {
      id,
      kind,
      serverUrl,
      roomCode: code,
      roomTitle: roomTitle || defaultTitle(kind, code),
      displayName,
      at,
      createdAt: Date.now(),
      hasPassword: Boolean(password),
      passwordFormat: password ? (this.db.usesSafeStorage ? 'safeStorage-v1' : 'plain-v0') : 'plain-v0',
      lobby,
      maxParticipants
    };
    await this.db.saveScheduledJoin({ ...record, password });
    // Validate after persisting so the cap and re-arm logic stay in one place.
    const added = this.scheduler.add({ ...record });
    if (!added.ok) {
      this.db.removeScheduledJoin(id);
      throw new Error(added.error);
    }
    return record;
  }

  cancel(id: unknown): void {
    this.scheduler.cancel(requireString(id, 64));
  }

  /** Wipe every plan and re-arm, so a data reset can't leave a live timer. */
  clear(): void {
    this.db.clearScheduledJoins();
    this.scheduler.refresh();
  }

  private recordOf(item: ScheduledJoin): ScheduledJoinRecord | undefined {
    return this.db.listScheduledJoins().find((record) => record.id === item.id);
  }

  private fromItem(item: ScheduledJoin): ScheduledJoinRecord {
    return {
      id: item.id,
      kind: item.kind,
      serverUrl: item.serverUrl,
      roomCode: item.roomCode,
      roomTitle: item.roomTitle,
      displayName: item.displayName,
      at: item.at,
      createdAt: item.createdAt,
      hasPassword: false,
      passwordFormat: 'plain-v0',
      lobby: item.lobby,
      maxParticipants: item.maxParticipants
    };
  }

  /** Decrypt the password only at fire time and hand the plan to the renderer. */
  private async fire(item: ScheduledJoin): Promise<void> {
    const record = this.recordOf(item) ?? this.fromItem(item);
    const password = record.hasPassword
      ? await this.db.loadScheduledJoinPassword(record.id)
      : undefined;
    this.db.removeScheduledJoin(record.id);
    this.push(IPC.scheduledJoin, record, {
      password: password ?? undefined,
      // A stored password we can no longer decrypt means the join will need one.
      passwordUnavailable: record.hasPassword && password === null
    });
    for (const window of this.windows()) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
    }
  }

  private push(
    channel: string,
    record: ScheduledJoinRecord,
    extra: Partial<ScheduledJoinEvent> = {}
  ): void {
    for (const window of this.windows()) {
      window.webContents.send(channel, { ...record, ...extra });
    }
  }
}
