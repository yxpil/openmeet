import { randomUUID } from 'node:crypto';
import type { ScheduledJoinKind } from '../shared/ipc.js';

export interface ScheduledJoin {
  id: string;
  kind: ScheduledJoinKind;
  serverUrl: string;
  roomCode: string;
  roomTitle: string;
  displayName: string;
  /** Epoch milliseconds since the Unix epoch, local clock. */
  at: number;
  createdAt: number;
  password?: string;
  lobby: boolean;
  maxParticipants: number;
}

export interface ScheduleStore {
  list(): ScheduledJoin[];
  remove(id: string): void;
}

export interface JoinSchedulerHooks {
  /** Fired `remindBeforeMs` ahead of the join; the user can still cancel. */
  onRemind?: (item: ScheduledJoin) => void;
  /** Time reached: the renderer should run the normal join flow. */
  onFire?: (item: ScheduledJoin) => void;
  /** A schedule whose time passed while the app was closed. It is dropped, never joined late. */
  onMissed?: (item: ScheduledJoin) => void;
  onError?: (message: string) => void;
  now?: () => number;
  setTimeoutFn?: (callback: () => void, ms: number) => () => void;
  remindBeforeMs?: number;
}

export const SCHEDULE_LIMIT = 50;
export const SCHEDULE_MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_REMIND_BEFORE_MS = 60_000;

export type ScheduleValidation = { ok: true } | { ok: false; error: string };

/** Shared by the IPC boundary and the tests so the rules cannot drift apart. */
export function validateSchedule(input: {
  at: number;
  kind: ScheduledJoinKind;
  roomCode: string;
  serverUrl: string;
  displayName: string;
  now: number;
}): ScheduleValidation {
  const code = input.roomCode.trim().toUpperCase();
  if (input.kind === 'server' && !/^[A-Z0-9-]{4,16}$/.test(code)) {
    return { ok: false, error: '房间号不合法' };
  }
  if (input.kind === 'p2p' && !/^[A-Z0-9]{4,16}$/.test(code.replace(/[^A-Z0-9]/g, ''))) {
    return { ok: false, error: '会议号需为 4–16 位字母或数字' };
  }
  // A hosted LAN room invents its own code at fire time, so none is required.
  if (input.kind === 'server' && !/^https?:\/\/.+/i.test(input.serverUrl.trim())) {
    return { ok: false, error: '服务器地址不合法' };
  }
  const name = input.displayName.trim();
  if (name.length < 1 || name.length > 40) return { ok: false, error: '显示名称需为 1–40 个字符' };
  if (!Number.isFinite(input.at)) return { ok: false, error: '入会时间不合法' };
  if (input.at <= input.now) return { ok: false, error: '入会时间必须晚于现在' };
  if (input.at - input.now > SCHEDULE_MAX_AHEAD_MS) return { ok: false, error: '最多提前 90 天预约' };
  return { ok: true };
}

export function newScheduleId(): string {
  return `sj_${randomUUID()}`;
}

/**
 * Drives scheduled joins with a single self-rescheduling timer aimed at the next
 * event, instead of polling a list every second.
 */
export class JoinScheduler {
  private readonly store: ScheduleStore;
  private readonly hooks: JoinSchedulerHooks;
  private readonly remindBeforeMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly reminded = new Set<string>();
  private readonly fired = new Set<string>();
  private cancelTimer: (() => void) | null = null;
  private running = false;

  constructor(store: ScheduleStore, hooks: JoinSchedulerHooks = {}) {
    this.store = store;
    this.hooks = hooks;
    this.now = hooks.now ?? Date.now;
    this.remindBeforeMs = hooks.remindBeforeMs ?? DEFAULT_REMIND_BEFORE_MS;
    this.setTimer =
      hooks.setTimeoutFn ??
      ((callback, ms) => {
        const timer = setTimeout(callback, Math.max(0, ms));
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Anything already due was missed while we were closed: drop it rather than
    // barging into a meeting the user may have long since left.
    const now = this.now();
    for (const item of this.store.list()) {
      if (item.at <= now) {
        this.store.remove(item.id);
        this.hooks.onMissed?.(item);
      }
    }
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  list(): ScheduledJoin[] {
    return [...this.store.list()].filter((item) => !this.fired.has(item.id)).sort((a, b) => a.at - b.at);
  }

  get nextFireAt(): number | null {
    const now = this.now();
    const upcoming = this.list().filter((item) => item.at > now);
    return upcoming.length > 0 ? (upcoming[0]?.at ?? null) : null;
  }

  add(item: ScheduledJoin): ScheduleValidation {
    if (this.store.list().length >= SCHEDULE_LIMIT) return { ok: false, error: '定时入会数量已达上限' };
    const validation = validateSchedule({
      at: item.at,
      kind: item.kind,
      roomCode: item.roomCode,
      serverUrl: item.serverUrl,
      displayName: item.displayName,
      now: this.now()
    });
    if (validation.ok && this.running) this.arm();
    return validation;
  }

  cancel(id: string): void {
    this.store.remove(id);
    this.reminded.delete(id);
    this.fired.delete(id);
    if (this.running) this.arm();
  }

  /** Re-arm after the store changed underneath us (e.g. hydrating at boot). */
  refresh(): void {
    if (this.running) this.arm();
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (!this.running) return;
    const now = this.now();
    const items = this.list().filter((item) => item.at > now - 1000);
    if (items.length === 0) return;

    const next = items[0];
    if (!next) return;
    const remindAt = next.at - this.remindBeforeMs;
    const needsRemind = remindAt > now && !this.reminded.has(next.id);
    const delay = (needsRemind ? remindAt : next.at) - now;
    this.cancelTimer = this.setTimer(() => this.tick(), Math.max(0, delay));
  }

  private tick(): void {
    if (!this.running) return;
    const now = this.now();
    for (const item of this.list()) {
      if (item.at <= now) {
        // The owner consumes the plan — it may still have to read the stored
        // password. Marking it here guarantees a plan is never fired twice.
        this.fired.add(item.id);
        this.reminded.delete(item.id);
        try {
          this.hooks.onFire?.(item);
        } catch (error) {
          this.hooks.onError?.(error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      if (!this.reminded.has(item.id) && item.at - now <= this.remindBeforeMs) {
        this.reminded.add(item.id);
        try {
          this.hooks.onRemind?.(item);
        } catch {
          // a failed reminder must not stop the join itself
        }
      }
    }
    this.arm();
  }
}
