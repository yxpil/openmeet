import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JoinScheduler,
  SCHEDULE_LIMIT,
  validateSchedule,
  type ScheduledJoin
} from '../src/main/scheduled.js';

/** A store and clock we control, so no test ever waits on wall time. */
class FakeStore {
  items = new Map<string, ScheduledJoin>();
  list(): ScheduledJoin[] {
    return [...this.items.values()];
  }
  remove(id: string): void {
    this.items.delete(id);
  }
}

function harness(
  options: { now?: number; remindBeforeMs?: number; consumeOnFire?: boolean } = {}
) {
  let clock = options.now ?? 1_700_000_000_000;
  const pending: { id: number; at: number; callback: () => void }[] = [];
  let seq = 1;
  const setTimeoutFn = (callback: () => void, ms: number) => {
    const entry = { id: seq++, at: clock + ms, callback };
    pending.push(entry);
    return () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  const advance = (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = pending
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = Math.max(clock, due.at);
      const index = pending.indexOf(due);
      if (index >= 0) pending.splice(index, 1);
      due.callback();
    }
    clock = target;
  };
  const store = new FakeStore();
  const fired: ScheduledJoin[] = [];
  const reminded: ScheduledJoin[] = [];
  const missed: ScheduledJoin[] = [];
  const scheduler = new JoinScheduler(store, {
    now: () => clock,
    setTimeoutFn,
    remindBeforeMs: options.remindBeforeMs ?? 60_000,
    onFire: (item) => {
      fired.push(item);
      if (options.consumeOnFire !== false) store.remove(item.id);
    },
    onRemind: (item) => reminded.push(item),
    onMissed: (item) => missed.push(item)
  });
  let created = 0;
  const schedule = (over: Partial<ScheduledJoin> = {}): ScheduledJoin => ({
    id: `sj_${(created += 1)}`,
    kind: 'server',
    serverUrl: 'http://127.0.0.1:8787',
    roomCode: 'ABC-DEF-GHI',
    roomTitle: '周会',
    displayName: '小明',
    at: clock + 10 * 60_000,
    createdAt: clock,
    lobby: false,
    maxParticipants: 8,
    ...over
  });
  return { scheduler, store, fired, reminded, missed, advance, now: () => clock, schedule };
}

describe('scheduled join validation', () => {
  const base = {
    kind: 'server' as const,
    serverUrl: 'http://h:1',
    displayName: '小明',
    now: 1_000_000
  };

  it('rejects a time that is not in the future', () => {
    const result = validateSchedule({ ...base, roomCode: 'ABC-DEF-GHI', at: base.now });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /晚于现在/);
  });

  it('rejects malformed room codes and non-http servers', () => {
    assert.equal(validateSchedule({ ...base, roomCode: 'AB', at: base.now + 1000 }).ok, false);
    assert.equal(validateSchedule({ ...base, roomCode: 'ABC DEF', at: base.now + 1000 }).ok, false);
    assert.equal(
      validateSchedule({ ...base, serverUrl: 'ftp://h', roomCode: 'ABC-DEF-GHI', at: base.now + 1000 }).ok,
      false
    );
    assert.equal(
      validateSchedule({ ...base, displayName: '  ', roomCode: 'ABC-DEF-GHI', at: base.now + 1000 }).ok,
      false
    );
  });

  it('caps how far ahead a join may be planned', () => {
    const far = base.now + 91 * 24 * 60 * 60 * 1000;
    const result = validateSchedule({ ...base, roomCode: 'ABC-DEF-GHI', at: far });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /90 天/);
  });

  it('applies the right rules per kind', () => {
    // A hosted LAN room invents its code at fire time, so none is required and
    // there is no server to name.
    assert.equal(validateSchedule({ ...base, kind: 'lan', roomCode: '', serverUrl: '', at: base.now + 1000 }).ok, true);
    // Serverless codes are user-chosen: server-style dashes are not accepted.
    assert.equal(
      validateSchedule({ ...base, kind: 'p2p', roomCode: 'OM7K2QD9', serverUrl: '', at: base.now + 1000 }).ok,
      true
    );
    assert.equal(
      validateSchedule({ ...base, kind: 'p2p', roomCode: 'AB', serverUrl: '', at: base.now + 1000 }).ok,
      false
    );
    // But a server plan still needs its server.
    assert.equal(
      validateSchedule({ ...base, kind: 'server', roomCode: 'ABC-DEF-GHI', serverUrl: '', at: base.now + 1000 }).ok,
      false
    );
  });
});

describe('join scheduler', () => {
  it('reminds once ahead of time, then fires exactly at the scheduled moment', () => {
    const h = harness();
    const item = h.schedule({ at: h.now() + 10 * 60_000 });
    h.store.items.set(item.id, item);
    h.scheduler.start();

    h.advance(8 * 60_000);
    assert.equal(h.fired.length, 0, 'must not fire early');
    assert.equal(h.reminded.length, 0, 'reminder is due at T-60s, i.e. minute 9');

    h.advance(60_000);
    assert.equal(h.reminded.length, 1, 'reminder should have happened at T-60s');
    assert.equal(h.fired.length, 0);

    h.advance(59_000);
    assert.equal(h.fired.length, 0);
    assert.equal(h.reminded.length, 1, 'reminder must not repeat');

    h.advance(60_000);
    assert.equal(h.fired.length, 1);
    assert.equal(h.fired[0]?.id, item.id);
    assert.equal(h.store.items.size, 0, 'a fired schedule is consumed');
  });

  it('never joins late: plans that passed while closed are dropped, not fired', () => {
    const h = harness();
    const past = h.schedule({ at: h.now() - 5 * 60_000 });
    const future = h.schedule({ at: h.now() + 20 * 60_000 });
    h.store.items.set(past.id, past);
    h.store.items.set(future.id, future);

    h.scheduler.start();
    assert.equal(h.fired.length, 0, 'a missed meeting must not be barged into');
    assert.deepEqual(h.missed.map((item) => item.id), [past.id]);
    assert.equal(h.store.items.has(past.id), false);
    assert.equal(h.store.items.has(future.id), true);
  });

  it('cancelling prevents both the reminder and the fire', () => {
    const h = harness();
    const item = h.schedule({ at: h.now() + 5 * 60_000 });
    h.store.items.set(item.id, item);
    h.scheduler.start();
    h.scheduler.cancel(item.id);
    h.advance(10 * 60_000);
    assert.equal(h.reminded.length, 0);
    assert.equal(h.fired.length, 0);
  });

  it('fires several plans in order and keeps the earliest armed', () => {
    const h = harness({ remindBeforeMs: 30_000 });
    const first = h.schedule({ at: h.now() + 60_000 });
    const second = h.schedule({ at: h.now() + 120_000 });
    h.store.items.set(first.id, first);
    h.store.items.set(second.id, second);
    h.scheduler.start();

    h.advance(70_000);
    assert.deepEqual(h.fired.map((item) => item.id), [first.id]);
    h.advance(60_000);
    assert.deepEqual(h.fired.map((item) => item.id), [first.id, second.id]);
  });

  it('does not fire the same plan twice while the owner is still consuming it', () => {
    const h = harness({ consumeOnFire: false, remindBeforeMs: 30_000 });
    const item = h.schedule({ at: h.now() + 60_000 });
    h.store.items.set(item.id, item);
    h.scheduler.start();

    h.advance(61_000);
    assert.equal(h.fired.length, 1);
    h.advance(180_000);
    assert.equal(h.fired.length, 1, 'a due plan must never repeat');
  });

  it('refuses to store more than the cap', () => {
    const h = harness();
    for (let i = 0; i < SCHEDULE_LIMIT; i += 1) {
      const item = h.schedule({ id: `full_${i}`, at: h.now() + (i + 1) * 600_000 });
      h.store.items.set(item.id, item);
    }
    h.scheduler.start();
    const overflow = h.schedule({ id: 'overflow', at: h.now() + 9 * 60_000 });
    const result = h.scheduler.add(overflow);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /上限/);
  });

  it('reports the next planned time for the UI countdown', () => {
    const h = harness();
    assert.equal(h.scheduler.nextFireAt, null);
    const item = h.schedule({ at: h.now() + 90_000 });
    h.store.items.set(item.id, item);
    h.scheduler.start();
    assert.equal(h.scheduler.nextFireAt, item.at);
  });
});
